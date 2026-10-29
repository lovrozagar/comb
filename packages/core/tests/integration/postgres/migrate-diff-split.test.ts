/**
 * `migrate diff` on Postgres with the real Atlas over a history Atlas splits as it runs it (M75):
 * each file is read as the statements Postgres runs, a delimiter directive in place, and the copy
 * Atlas replays is written so Atlas sends each statement alone.
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { PgTarget } from "../../../src/migrate/core/atlas-target.ts"
import { generateIncrementalMigration } from "../../../src/migrate/core/migrate-diff.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { withScratchDb } from "../support/pg.ts"

/* a diff and a baseline read Postgres files with Postgres's parser, which their callers load (M75) */
beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-diff-split-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const target = (devUrl: string): PgTarget => ({ devUrl, lockTimeout: "5s", schema: "public", url: "" })

/** One diff of `schema` into the migrations directory */
const diff = (dev: PgTarget, schema: string) =>
	generateIncrementalMigration({
		dialect: "postgres",
		migrationName: "step",
		migrationsDir: dir,
		target: dev,
		targetSchema: schema,
	})

async function query(url: string, sql: string): Promise<void> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		await client.query(sql)
	} finally {
		await client.end()
	}
}

/** A hand-written migration `name` added to the history, with atlas.sum rehashed */
function handWritten(name: string, sql: string): void {
	writeFileSync(join(dir, name), sql)
	spawnSync("atlas", ["migrate", "hash", "--dir", `file://${dir}`])
}

const roleName = () => `comb_app_${randomUUID().slice(0, 8)}`

const POST = 'CREATE TABLE "post" ("id" integer PRIMARY KEY, "title" text NOT NULL);\n'

describe("migrate diff on Postgres: a history Atlas splits as it runs it", () => {
	describe("with Atlas v1.3.0", () => {
		it("replays a history split by its own delimiter, a chunk of several statements among it, and finds it synced", async () => {
			const role = roleName()
			const histories = [
				`-- atlas:delimiter GO\n\nCREATE ROLE "${role}"\nGO\n${POST.trim().replace(/;$/, "")}\nGO\n`,
				`-- atlas:delimiter GO\n\nCREATE ROLE "${role}"; ${POST.trim()}\nGO\n`,
				`-- atlas:delimiter GO\n\n${POST.trim().replace(/;$/, "")} -- the posts\nGO\n`,
			]
			try {
				for (const [i, history] of histories.entries()) {
					await withScratchDb(async (devUrl) => {
						rmSync(dir, { force: true, recursive: true })
						mkdirSync(dir)
						handWritten("20260101000000_go.sql", history)
						const schema = i < 2 ? `CREATE ROLE "${role}";\n${POST}` : POST
						expect(await diff(target(devUrl), schema)).toEqual({ files: [], notices: [], synced: true })
					})
				}
			} finally {
				await withScratchDb((url) => query(url, `DROP ROLE IF EXISTS "${role}"`))
			}
		}, 120_000)

		it("replays a BEGIN ATOMIC function and a rule's action list, each one statement, and finds it synced", async () => {
			await withScratchDb(async (devUrl) => {
				const log = 'CREATE TABLE "log" ("id" integer);\n'
				handWritten(
					"20260101000000_code.sql",
					`${POST}${log}CREATE FUNCTION "one"() RETURNS integer LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END;\nCREATE RULE "r" AS ON INSERT TO "post" DO ALSO (INSERT INTO "log" VALUES (1); INSERT INTO "log" VALUES (2));\n`,
				)
				expect(await diff(target(devUrl), `${POST}${log}`)).toEqual({ files: [], notices: [], synced: true })
			})
		}, 60_000)
	})
})
