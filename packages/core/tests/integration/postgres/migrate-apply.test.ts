/**
 * `migrate apply`, `baseline` and `status` on Postgres with the real Atlas: each case writes a
 * migrations directory, applies it to a scratch database through applyWithAtlas, and reads the
 * result back from the database.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas, baselineWithAtlas, statusWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { splitEnumValues } from "../../../src/migrate/core/pg-enum-split.ts"
import { wrapAtlasFile } from "../../../src/migrate/core/pg-objects.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"

import { withScratchDb } from "../support/pg.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-apply-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** The migrations directory holding `files`, hashed */
function migrations(files: Record<string, string>): void {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	hashDir(run, dir)
}

/** The options applyWithAtlas takes for the database at `url`, collecting what it prints */
function command(
	url: string,
	more: {
		approve?: (m: ParsedMigration) => ReturnType<typeof approveMigration>
		devUrl?: string
		lockTimeout?: string
		schema?: string
	} = {},
) {
	const out: string[] = []
	/* apply and status never use the dev database, and no test here may start a container; baseline's compare gets a scratch one */
	const devUrl = more.devUrl ?? "postgres://comb-no-dev.invalid/dev"
	const target = { devUrl, lockTimeout: more.lockTimeout ?? "5s", schema: more.schema ?? "public", url }
	const approve = more.approve ?? ((m: ParsedMigration) => approveMigration(m, { target: "core", yes: false }))
	/* no exec: applyWithAtlas runs the real atlas by default */
	return { approve, dir, out, print: (line: string) => out.push(line), target }
}

/** A scratch dev database and a scratch target for `run` */
const withDevAndTarget = (body: (dev: string, url: string) => Promise<void>) =>
	withScratchDb((dev) => withScratchDb((url) => body(dev, url)))

async function query<T>(url: string, sql: string): Promise<T[]> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		return (await client.query(sql)).rows as T[]
	} finally {
		await client.end()
	}
}

const tables = async (url: string) =>
	(
		await query<{ tablename: string }>(url, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
	).map((r) => r.tablename)
const revisions = async (url: string) =>
	(
		await query<{ version: string }>(
			url,
			"SELECT version FROM atlas_schema_revisions.atlas_schema_revisions ORDER BY 1",
		)
	).map((r) => r.version)

/** An approval that, while it is asked, rewrites the file it approves and rehashes the directory */
async function editWhileAsking(m: ParsedMigration) {
	writeFileSync(join(dir, m.filename), 'CREATE TABLE "swapped" ("id" integer);\n')
	hashDir(run, dir)
	return approveMigration(m, { target: "core", yes: false })
}

describe("migrate apply on Postgres", () => {
	describe("with Atlas v1.3.0", () => {
		it("applies, keeps the history out of public, and applies nothing the second time", async () => {
			await withScratchDb(async (url) => {
				migrations({
					"20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n',
					"20260102000000_b.sql": 'CREATE TABLE "b" ("id" integer);\n',
				})
				expect(await applyWithAtlas(command(url))).toEqual(["20260101000000_a.sql", "20260102000000_b.sql"])
				expect(await tables(url)).toEqual(["a", "b"])
				expect(await revisions(url)).toEqual(["20260101000000", "20260102000000"])
				const again = command(url)
				expect(await applyWithAtlas(again)).toEqual([])
				expect(again.out).toEqual(["No migrations to apply"])
			})
		}, 60_000)

		it("refuses an unsafe file without approval, and applies it with the file's own approval", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n' })
				await applyWithAtlas(command(url))
				migrations({ "20260102000000_drop.sql": 'DROP TABLE "a";\n' })
				await expect(applyWithAtlas(command(url))).rejects.toThrow("20260102000000_drop.sql is unsafe")
				expect(await tables(url)).toEqual(["a"])
				migrations({ "20260102000000_drop.sql": '-- comb:allow-unsafe: a is retired\nDROP TABLE "a";\n' })
				const approved = command(url)
				await applyWithAtlas(approved)
				expect(approved.out).toContain("Approved in 20260102000000_drop.sql: a is retired")
				expect(await tables(url)).toEqual([])
			})
		}, 60_000)

		it("rolls back a failing file and keeps the ones before it", async () => {
			await withScratchDb(async (url) => {
				migrations({
					"20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n',
					"20260102000000_bad.sql": 'CREATE TABLE "b" ("id" integer);\nALTER TABLE "nope" ADD COLUMN "x" integer;\n',
				})
				await expect(applyWithAtlas(command(url))).rejects.toThrow(
					'20260102000000_bad.sql failed at ALTER TABLE "nope" ADD COLUMN "x" integer;: pq: relation "nope" does not exist (42P01). It was rolled back',
				)
				expect(await tables(url)).toEqual(["a"])
				expect(await revisions(url)).toEqual(["20260101000000"])
			})
		}, 60_000)
	})
})

describe("migrate check on Postgres reads only (M11)", () => {
	describe("with Atlas v1.3.0", () => {
		it("checks a database with no history without creating Atlas's revisions schema on it", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000_init.sql": "CREATE TABLE post (id integer PRIMARY KEY);" })
				const schemas = () =>
					query<{ nspname: string }>(
						url,
						"SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1",
					)
				const before = await schemas()
				expect(await applyWithAtlas({ ...command(url), checkOnly: true })).toEqual(["20260101000000_init.sql"])
				expect(await schemas()).toEqual(before)
				expect(await tables(url)).toEqual([])
			})
		}, 60_000)

		it("refuses a database with tables but no history, as apply does, and still writes nothing", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000_init.sql": "CREATE TABLE post (id integer PRIMARY KEY);" })
				await query(url, "CREATE TABLE legacy (id integer); INSERT INTO legacy VALUES (1)")
				const refusal =
					"the database has objects but no migration history (before 0.13, a schema other than public kept its history in the shared atlas_schema_revisions); if its schema matches the migrations, record them with comb migrate baseline"
				await expect(applyWithAtlas(command(url))).rejects.toThrow(refusal)
				await query(url, "DROP SCHEMA IF EXISTS atlas_schema_revisions CASCADE")
				await expect(applyWithAtlas({ ...command(url), checkOnly: true })).rejects.toThrow(refusal)
				const made = await query(url, "SELECT 1 FROM pg_namespace WHERE nspname = 'atlas_schema_revisions'")
				expect(made).toEqual([])
				expect(await tables(url)).toEqual(["legacy"])
			})
		}, 60_000)
	})
})

describe("migrate apply on Postgres: history it refuses", () => {
	describe("with Atlas v1.3.0", () => {
		it("refuses a file added before one already applied", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260102000000_b.sql": 'CREATE TABLE "b" ("id" integer);\n' })
				await applyWithAtlas(command(url))
				migrations({ "20260101000000_late.sql": 'CREATE TABLE "late" ("id" integer);\n' })
				await expect(applyWithAtlas(command(url))).rejects.toThrow(
					"20260101000000_late.sql is older than a migration already applied; rename it to a newer version and run atlas migrate hash",
				)
				expect(await tables(url)).toEqual(["b"])
			})
		}, 60_000)

		it("applies what it classified, not an edit made while it was asking", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n' })
				await applyWithAtlas(command(url, { approve: editWhileAsking }))
				expect(await tables(url)).toEqual(["a"])
			})
		}, 60_000)
	})
})

describe("migrate apply on Postgres: locks", () => {
	describe("with Atlas v1.3.0", () => {
		it("fails an ALTER that waits behind a reader after lockTimeout, instead of queueing every query", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n' })
				await applyWithAtlas(command(url))
				const reader = new pg.Client({ connectionString: url })
				await reader.connect()
				try {
					await reader.query('BEGIN; SELECT * FROM "a"')
					migrations({ "20260102000000_alter.sql": 'ALTER TABLE "a" ADD COLUMN "x" integer;\n' })
					const started = Date.now()
					await expect(applyWithAtlas(command(url, { lockTimeout: "1s" }))).rejects.toThrow("lock timeout")
					expect(Date.now() - started).toBeLessThan(15_000)
				} finally {
					await reader.query("ROLLBACK")
					await reader.end()
				}
			})
		}, 60_000)

		it("says another apply is running when Atlas cannot take its lock", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n' })
				const other = new pg.Client({ connectionString: url })
				await other.connect()
				try {
					/* the session lock Atlas takes while it applies (pg_locks objid 2686470616) */
					await other.query("SELECT pg_advisory_lock(2686470616)")
					await expect(applyWithAtlas(command(url))).rejects.toThrow(
						"another migrate apply is running on this database",
					)
				} finally {
					await other.end()
				}
			})
		}, 60_000)
	})
})

describe("migrate baseline and status on Postgres", () => {
	describe("with Atlas v1.3.0", () => {
		it("records the history of a database set up by hand, runs none of it, and then has nothing to apply", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				await query(url, 'CREATE TABLE "a" ("id" integer)')
				migrations({
					"20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n',
					"20260102000000_b.sql": "SELECT 1;\n",
				})
				await expect(applyWithAtlas(command(url))).rejects.toThrow("record them with comb migrate baseline")
				const baseline = command(url, { devUrl })
				expect(baselineWithAtlas(baseline)).toEqual(["20260101000000_a.sql", "20260102000000_b.sql"])
				expect(await revisions(url)).toEqual(["20260101000000", "20260102000000"])
				expect(await applyWithAtlas(command(url))).toEqual([])
				expect(() => baselineWithAtlas(command(url, { devUrl }))).toThrow("the database already records 2 migrations")
				const status = command(url)
				statusWithAtlas(status)
				expect(status.out).toEqual(["Applied: 2 (up to 20260102000000)", "Pending: none"])
			})
		}, 60_000)

		it("records nothing on a database whose tables are not the ones the migrations leave", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				await query(url, 'CREATE TABLE "a" ("id" integer, "extra" text)')
				migrations({
					"20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\nCREATE VIEW "v" AS (select 1 as x);\n',
				})
				expect(() => baselineWithAtlas(command(url, { devUrl }))).toThrow(
					/^the database's tables are not the ones the migrations leave, so baseline records nothing; the difference:\n[\s\S]*DROP COLUMN "extra"/,
				)
				expect(await query(url, "SELECT 1 FROM pg_namespace WHERE nspname = 'atlas_schema_revisions'")).toEqual([])
			})
		}, 60_000)

		it("refuses an applied file that was edited and rehashed since, in status and apply (M17)", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n' })
				await applyWithAtlas(command(url))
				migrations({ "20260101000000_a.sql": 'CREATE TABLE "a" ("id" bigint);\n' })
				const refusal = /^20260101000000_a\.sql was applied, then edited/
				expect(() => statusWithAtlas(command(url))).toThrow(refusal)
				await expect(applyWithAtlas(command(url))).rejects.toThrow(refusal)
			})
		}, 60_000)
	})
})

/* M21 of the 0.12 round: each schema keeps its own history, public the one it always had */
describe("migrate apply on Postgres: one history per schema", () => {
	describe("with Atlas v1.3.0", () => {
		it("applies one directory to two schemas of a database, each recorded apart", async () => {
			await withScratchDb(async (url) => {
				await query(url, "CREATE SCHEMA tenant_a; CREATE SCHEMA tenant_b")
				migrations({ "20260101000000_t.sql": 'CREATE TABLE "t" ("id" integer);\n' })
				expect(await applyWithAtlas(command(url, { schema: "tenant_a" }))).toEqual(["20260101000000_t.sql"])
				const pending = command(url, { schema: "tenant_b" })
				statusWithAtlas(pending)
				expect(pending.out).toEqual(["Applied: 0", "Pending: 20260101000000_t.sql"])
				expect(await applyWithAtlas(command(url, { schema: "tenant_b" }))).toEqual(["20260101000000_t.sql"])
				const where = await query<{ schemaname: string }>(
					url,
					"SELECT schemaname FROM pg_tables WHERE tablename = 't' ORDER BY 1",
				)
				expect(where.map((row) => row.schemaname)).toEqual(["tenant_a", "tenant_b"])
				const histories = await query<{ nspname: string }>(
					url,
					"SELECT nspname FROM pg_namespace WHERE nspname LIKE 'atlas_schema_revisions%' ORDER BY 1",
				)
				expect(histories.map((row) => row.nspname)).toEqual([
					"atlas_schema_revisions_tenant_a",
					"atlas_schema_revisions_tenant_b",
				])
			})
		}, 60_000)

		it("refuses a schema migrated before 0.13, whose history is the shared one, and says to baseline it", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				await query(devUrl, "CREATE SCHEMA tenant_a")
				await query(url, 'CREATE SCHEMA tenant_a; CREATE TABLE tenant_a."t" ("id" integer)')
				migrations({ "20260101000000_t.sql": 'CREATE TABLE "t" ("id" integer);\n' })
				const refusal =
					/before 0\.13, a schema other than public kept its history in the shared atlas_schema_revisions[\s\S]*comb migrate baseline/
				await expect(applyWithAtlas(command(url, { schema: "tenant_a" }))).rejects.toThrow(refusal)
				expect(baselineWithAtlas(command(url, { devUrl, schema: "tenant_a" }))).toEqual(["20260101000000_t.sql"])
				expect(await applyWithAtlas(command(url, { schema: "tenant_a" }))).toEqual([])
			})
		}, 60_000)
	})
})

/** --yes: a txmode none file is cautious */
const approveWithYes = (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true })

/* each writer, given a file whose directive has no blank line after it, as a person may write one */
const TIGHT = '-- atlas:txmode none\nCREATE INDEX CONCURRENTLY "a_x" ON "a" ("x");\n'

describe("migrate apply on Postgres: files comb rewrites keep their directives", () => {
	describe("with Atlas v1.3.0", () => {
		it("applies each rewritten txmode none file statement by statement, so CREATE INDEX CONCURRENTLY runs", async () => {
			await withScratchDb(async (url) => {
				migrations({
					"20260101000000_a.sql":
						'CREATE TYPE "s" AS ENUM (\'a\');\nCREATE TABLE "a" ("x" integer, "y" integer, "z" integer, "s" "s");\n',
				})
				await applyWithAtlas(command(url, { approve: approveWithYes }))
				writeFileSync(
					join(dir, "20260102000000_wrapped.sql"),
					wrapAtlasFile(TIGHT, { after: [], before: ["SELECT 1"] }),
				)
				const split = splitEnumValues(
					"20260103000000_enum.sql",
					`-- atlas:txmode none\nALTER TYPE "s" ADD VALUE 'b';\nCREATE INDEX CONCURRENTLY "a_y" ON "a" ("y");\n`,
				)
				for (const [name, sql] of split) writeFileSync(join(dir, name), sql)
				migrations({})
				const applied = await applyWithAtlas(command(url, { approve: approveWithYes }))
				expect(applied).toHaveLength(3)
				const indexes = await query<{ indexname: string }>(
					url,
					"SELECT indexname FROM pg_indexes WHERE tablename = 'a' ORDER BY 1",
				)
				expect(indexes.map((i) => i.indexname)).toEqual(["a_x", "a_y"])
			})
		}, 60_000)
	})
})

/** An approval of every file, for a history set up by the test */
const approveAll = () => Promise.resolve({ ok: true as const })

/*
 * M72 of the 0.13.0 round: comb scopes the URL to search_path=<schema>, so an unqualified name is the
 * schema's own; a trigger the history wrote on app.users fires on a later INSERT INTO users
 */
describe("migrate check on Postgres under a configured schema", () => {
	describe("with Atlas v1.3.0", () => {
		it("refuses a write to a table whose trigger the history named with the schema", async () => {
			await withScratchDb(async (url) => {
				await query(url, "CREATE SCHEMA app")
				migrations({
					"20260101000000_t.sql": `CREATE TABLE victim (id int PRIMARY KEY);
CREATE FUNCTION wipe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM victim; RETURN NEW; END $$;
CREATE TABLE users (id int);
CREATE TRIGGER t AFTER INSERT ON app.users FOR EACH ROW EXECUTE FUNCTION wipe();
`,
				})
				expect(await applyWithAtlas(command(url, { approve: approveAll, schema: "app" }))).toEqual([
					"20260101000000_t.sql",
				])
				migrations({ "20260102000000_seed.sql": "INSERT INTO users VALUES (1);\n" })
				await expect(applyWithAtlas({ ...command(url, { schema: "app" }), checkOnly: true })).rejects.toThrow(
					/20260102000000_seed\.sql is unsafe/,
				)
			})
		}, 60_000)
	})
})

/* M70 of the 0.13.0 round: Postgres DDL is rated from its parse tree, so no spelling hides a drop */
describe("migrate check on Postgres: DDL in any spelling", () => {
	describe("with Atlas v1.3.0", () => {
		it("refuses a column dropped with no space after the quoted table name", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000_t.sql": "CREATE TABLE users (id int PRIMARY KEY, email text);\n" })
				expect(await applyWithAtlas(command(url, { approve: approveAll }))).toEqual(["20260101000000_t.sql"])
				migrations({ "20260102000000_drop.sql": 'ALTER TABLE "users"DROP COLUMN email;\n' })
				await expect(applyWithAtlas({ ...command(url), checkOnly: true })).rejects.toThrow(
					/20260102000000_drop\.sql is unsafe/,
				)
			})
		}, 60_000)
	})
})

it("keeps the scratch directory per test", () => {
	expect(dir).toContain("comb-pg-apply-")
})
