/**
 * Plan 14's 5.4b: Atlas OSS compares a live database's tables with the history and leaves its
 * functions, procedures and triggers out without a word, so a database whose triggers differ found
 * itself in sync. A Postgres baseline compares them itself, by name, through postgres.js: a name
 * only one side has refuses the baseline, and names that match leave a warning that their bodies
 * were not compared. An extension's functions are the extension's, never the history's.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { baselineWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-baseline-objects-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const TABLE = 'CREATE TABLE "t" ("id" integer);\n'
const FUNCTION = "CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;\n"
const TRIGGER =
	"CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\nCREATE TRIGGER t_touch BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION touch();\n"

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

/** Baseline the database at `url` against a history of one file, `history`; what it printed, or why it refused */
async function baseline(url: string, devUrl: string, history: string) {
	writeFileSync(join(dir, "20260101000000_init.sql"), history)
	hashDir(run, dir)
	const out: string[] = []
	const target = { devUrl, lockTimeout: "5s", schema: "public", url }
	try {
		await baselineWithAtlas({ dir, print: (line: string) => out.push(line), target })
		return { out }
	} catch (error) {
		return { out, refused: (error as Error).message }
	}
}

const withDevAndTarget = (body: (dev: string, url: string) => Promise<void>) =>
	withScratchDb((dev) => withScratchDb((url) => body(dev, url)))

describe("a Postgres baseline: the functions, procedures and triggers Atlas OSS does not compare", () => {
	it("refuses a database holding a trigger the history lacks, recording nothing", async () => {
		await withDevAndTarget(async (devUrl, url) => {
			await exec(url, `${TABLE}${TRIGGER}`)
			const { refused } = await baseline(url, devUrl, TABLE)
			expect(refused).toBe(
				"the database's functions and triggers are not the ones the migrations leave, so baseline records nothing:\nfunction touch: only in the database\ntrigger t_touch on t: only in the database",
			)
			const client = new pg.Client({ connectionString: url })
			await client.connect()
			try {
				const history = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'atlas_schema_revisions'")
				expect(history.rows).toEqual([])
			} finally {
				await client.end()
			}
		})
	}, 60_000)

	it("refuses a database lacking a function the history makes", async () => {
		await withDevAndTarget(async (devUrl, url) => {
			await exec(url, TABLE)
			const { refused } = await baseline(url, devUrl, `${TABLE}${FUNCTION}`)
			expect(refused).toMatch(/so baseline records nothing:\nfunction f: only in the migrations$/)
		})
	}, 60_000)

	it("records a history whose names the database holds, warning that their bodies were not compared", async () => {
		await withDevAndTarget(async (devUrl, url) => {
			await exec(url, `${TABLE}${FUNCTION}${TRIGGER}`)
			const { out, refused } = await baseline(url, devUrl, `${TABLE}${FUNCTION}${TRIGGER}`)
			expect(refused).toBeUndefined()
			expect(out).toEqual([
				"Warning: the bodies of 3 functions, procedures and triggers were not compared: Atlas OSS cannot load them, and comb does not read them",
				"Marked applied: 20260101000000_init.sql",
			])
		})
	}, 60_000)

	it("leaves an extension's functions to the extension", async () => {
		await withDevAndTarget(async (devUrl, url) => {
			await exec(url, `CREATE EXTENSION pgcrypto;\n${TABLE}`)
			const { out, refused } = await baseline(url, devUrl, `CREATE EXTENSION IF NOT EXISTS pgcrypto;\n${TABLE}`)
			expect(refused).toBeUndefined()
			expect(out).toEqual(["Marked applied: 20260101000000_init.sql"])
		})
	}, 60_000)
})
