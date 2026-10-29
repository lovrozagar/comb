/**
 * Plan 14's 5.4b: Atlas OSS compares a live database's tables with the history and leaves its
 * functions, procedures and triggers out without a word, so a database whose triggers differ found
 * itself in sync. A Postgres baseline compares them itself through postgres.js, a function by its
 * name and arguments, a trigger by its name and how it fires (P13): one only one side has refuses
 * the baseline, and those that match leave a warning that their bodies were not compared. An extension's functions are the extension's, never the history's.
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
				"the database's functions and triggers are not the ones the migrations leave, so baseline records nothing:\nfunction touch(): only in the database\ntrigger t_touch on t (before insert, for each row): only in the database",
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
			expect(refused).toMatch(/so baseline records nothing:\nfunction f\(\): only in the migrations$/)
		})
	}, 60_000)

	it("records a history whose names the database holds, warning that their bodies were not compared", async () => {
		await withDevAndTarget(async (devUrl, url) => {
			await exec(url, `${TABLE}${FUNCTION}${TRIGGER}`)
			const { out, refused } = await baseline(url, devUrl, `${TABLE}${FUNCTION}${TRIGGER}`)
			expect(refused).toBeUndefined()
			expect(out).toEqual([
				"Warning: the bodies of 2 functions and 1 trigger were not compared: Atlas OSS cannot load them, and comb does not read them",
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

/* P13 of the 0.14.1 review: a function is its name and its arguments, a trigger its name, when it fires and whether it does */
/** The lines of a refusal's difference */
const lines = (refused: string | undefined) => refused?.split("\n").slice(1)

describe("a Postgres baseline: functions by their arguments, triggers by when they fire", () => {
	it("refuses an overload, or arguments, the history does not make", async () => {
		await withDevAndTarget(async (devUrl, url) => {
			const IN = "CREATE FUNCTION f(n integer) RETURNS integer LANGUAGE sql AS $$ SELECT n $$;\n"
			await exec(url, `${TABLE}${FUNCTION}${IN}CREATE FUNCTION g(t text) RETURNS text LANGUAGE sql AS $$ SELECT t $$;`)
			const history = `${TABLE}${FUNCTION}CREATE FUNCTION g(n integer) RETURNS integer LANGUAGE sql AS $$ SELECT n $$;\n`
			expect(lines((await baseline(url, devUrl, history)).refused)).toEqual([
				"function f(int4): only in the database",
				"function g(int4): only in the migrations",
				"function g(text): only in the database",
			])
		})
	}, 60_000)

	it("refuses a trigger that fires at another time, or not at all", async () => {
		await withDevAndTarget(async (devUrl, url) => {
			const after = TRIGGER.replace("BEFORE INSERT", "AFTER INSERT")
			await exec(
				url,
				`${TABLE}${after}CREATE TRIGGER t_off BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION touch();
ALTER TABLE t DISABLE TRIGGER t_off;`,
			)
			const history = `${TABLE}${TRIGGER}CREATE TRIGGER t_off BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION touch();\n`
			expect(lines((await baseline(url, devUrl, history)).refused)).toEqual([
				"trigger t_off on t (before update, for each row): only in the migrations",
				"trigger t_off on t (before update, for each row, disabled): only in the database",
				"trigger t_touch on t (after insert, for each row): only in the database",
				"trigger t_touch on t (before insert, for each row): only in the migrations",
			])
		})
	}, 60_000)

	it("records a history whose arrays, character types and statement triggers the database holds as written", async () => {
		await withDevAndTarget(async (devUrl, url) => {
			const both = `${TABLE}CREATE FUNCTION h(a integer[], b character varying, c timestamp with time zone) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
CREATE TRIGGER t_seen AFTER INSERT OR DELETE ON t FOR EACH STATEMENT EXECUTE FUNCTION touch();\n`
			await exec(url, both)
			const { out, refused } = await baseline(url, devUrl, both)
			expect(refused).toBeUndefined()
			expect(out).toEqual([
				"Warning: the bodies of 2 functions and 1 trigger were not compared: Atlas OSS cannot load them, and comb does not read them",
				"Marked applied: 20260101000000_init.sql",
			])
		})
	}, 60_000)
})
