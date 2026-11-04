/**
 * P4 of r19: Atlas replays the history without the views comb owns, so a statement that depends on a
 * view (a LANGUAGE sql function whose body reads it, a function returning SETOF it, a column of its row
 * type) failed that replay with Atlas's raw "relation does not exist", and `migrate diff` and baseline
 * both stopped on a history apply runs. Each view now replays where it stands, handed to the dev
 * database in a DO block Atlas runs and does not inspect.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { baselineWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { generateIncrementalMigration } from "../../../src/migrate/core/migrate-diff.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-view-dependents-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const TABLE = "CREATE TABLE t (id int PRIMARY KEY, a int);\n"
const VIEW = "CREATE VIEW v AS SELECT id, a FROM t;\n"

/* each shape the record names, and a view dropped and made again over its dependent's replay */
const CASES: Array<[string, string]> = [
	[
		"a LANGUAGE sql function whose body reads the view",
		"CREATE FUNCTION n() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM v';\n",
	],
	["a function returning SETOF the view", "CREATE FUNCTION g() RETURNS SETOF v LANGUAGE sql AS 'SELECT * FROM v';\n"],
	["a table column of the view's row type", "CREATE TABLE snap (id int PRIMARY KEY, row v);\n"],
	[
		"a materialized view's dependent",
		"CREATE MATERIALIZED VIEW m AS SELECT id FROM t;\nCREATE FUNCTION c() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM m';\n",
	],
]

/** Run `sql` on the database at `url` */
async function exec(url: string, sql: string): Promise<void> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		await client.query(sql)
	} finally {
		await client.end()
	}
}

/** The history: the table, the view, and the dependent, in one file */
async function history(dependent: string): Promise<string> {
	const sql = `${TABLE}${VIEW}${dependent}`
	writeFileSync(join(dir, "20260101000000_init.sql"), sql)
	await hashDir(run, dir)
	return sql
}

describe("migrate diff over a history with a dependent of a view (P4 of r19)", () => {
	it.each(CASES)("finds the target in sync: %s", async (_, dependent) => {
		await history(dependent)
		const target = dependent.includes("snap")
			? `${TABLE}${VIEW}CREATE TABLE snap (id int PRIMARY KEY, row v);`
			: `${TABLE}${VIEW}`
		const result = await withScratchDb((dev) =>
			generateIncrementalMigration({
				dialect: "postgres",
				migrationName: "step",
				migrationsDir: dir,
				target: { devUrl: dev, lockTimeout: "5s", schema: "public", url: "" },
				targetSchema: dependent.includes("MATERIALIZED")
					? `${TABLE}${VIEW}CREATE MATERIALIZED VIEW m AS SELECT id FROM t;`
					: target,
			}),
		)
		expect(result).toMatchObject({ synced: true })
	})
})

describe("a Postgres baseline of a history with a dependent of a view (P4 of r19)", () => {
	it.each(CASES)("baselines a target the files built: %s", async (_, dependent) => {
		const sql = await history(dependent)
		const refused = await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				await exec(url, sql)
				try {
					await baselineWithAtlas({
						dir,
						print: () => undefined,
						target: { devUrl: dev, lockTimeout: "5s", schema: "public", url },
					})
					return undefined
				} catch (error) {
					return (error as Error).message
				}
			}),
		)
		expect(refused).toBeUndefined()
	})
})
