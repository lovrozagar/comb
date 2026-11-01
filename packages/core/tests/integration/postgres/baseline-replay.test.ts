/**
 * P5 of r19: a Postgres baseline compares the target's catalog with the catalog the history leaves on
 * the dev database, both read by one query, so Postgres alone decides what a cascade, a rename or a
 * move takes. Every target here is built by running the same files, so each must baseline: the cascade
 * siblings (P5, P1), a kind moved schema (P9), RLS commands combined in one ALTER (P14), policy roles as
 * Postgres stores them (P17), and a dev database reached as another role (CURRENT_USER).
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
import { refuseObjectDrift, UNCOMPARED } from "../../../src/migrate/core/baseline-compare.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-baseline-replay-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

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

/** Baseline the database at `url` against `files`, in order; why it refused, or undefined */
async function baseline(url: string, devUrl: string, files: readonly string[]): Promise<string | undefined> {
	files.forEach((sql, i) => writeFileSync(join(dir, `2026010100000${i}_f.sql`), sql))
	hashDir(run, dir)
	const target = { devUrl, lockTimeout: "5s", schema: "public", url }
	try {
		await baselineWithAtlas({ dir, print: () => undefined, target })
		return undefined
	} catch (error) {
		return (error as Error).message
	}
}

/** A target built by `files`, then baselined against them on a fresh dev database */
const built = (files: readonly string[]) =>
	withScratchDb((dev) =>
		withScratchDb(async (url) => {
			for (const sql of files) await exec(url, sql)
			return baseline(url, dev, files)
		}),
	)

const F = "CREATE FUNCTION f(int) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT $1';\n"

describe("a Postgres baseline of a history whose CASCADE drop Postgres follows (P5, P1)", () => {
	it.each([
		[
			"a dropped column a join view does not read",
			"CREATE TABLE t (id int PRIMARY KEY, c int);\nCREATE TABLE u (id int PRIMARY KEY, c int);\nCREATE VIEW v AS SELECT u.c FROM t JOIN u USING (id);\nALTER TABLE t DROP COLUMN c CASCADE;\n",
		],
		[
			"a function a view uses through an operator",
			`${F}CREATE OPERATOR @@@ (RIGHTARG = int, FUNCTION = f);\nCREATE TABLE t (id int PRIMARY KEY);\nCREATE VIEW v AS SELECT @@@ id AS x FROM t;\nDROP FUNCTION f(int) CASCADE;\n`,
		],
		[
			"a function a policy uses through an operator",
			`${F}CREATE OPERATOR @@@ (RIGHTARG = int, FUNCTION = f);\nCREATE TABLE t (id int PRIMARY KEY);\nCREATE POLICY p ON t USING (@@@ id > 0);\nDROP FUNCTION f(int) CASCADE;\n`,
		],
		[
			"a table a BEGIN ATOMIC function reads",
			"CREATE TABLE t (id int PRIMARY KEY);\nCREATE FUNCTION n() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(*) FROM t; END;\nDROP TABLE t CASCADE;\n",
		],
		[
			"a type a function takes",
			"CREATE TYPE mood AS ENUM ('a', 'b');\nCREATE FUNCTION m(mood) RETURNS int LANGUAGE sql AS 'SELECT 1';\nDROP TYPE mood CASCADE;\n",
		],
		[
			"a type a view casts to",
			"CREATE TYPE mood AS ENUM ('a', 'b');\nCREATE TABLE t (id int PRIMARY KEY);\nCREATE VIEW v AS SELECT 'a'::mood AS m FROM t;\nDROP TYPE mood CASCADE;\n",
		],
		[
			"a table a rule on another table writes",
			"CREATE TABLE t (id int PRIMARY KEY);\nCREATE TABLE u (id int PRIMARY KEY);\nCREATE RULE r AS ON INSERT TO u DO ALSO INSERT INTO t VALUES (NEW.id);\nDROP TABLE t CASCADE;\n",
		],
		[
			"an extension a view uses",
			"CREATE EXTENSION IF NOT EXISTS pg_trgm;\nCREATE TABLE t (id int PRIMARY KEY, s text);\nCREATE VIEW v AS SELECT similarity(s, 'x') AS sim FROM t;\nDROP EXTENSION pg_trgm CASCADE;\n",
		],
		[
			"a schema a view in public reads",
			"CREATE SCHEMA o;\nCREATE TABLE o.t (id int PRIMARY KEY);\nCREATE VIEW v AS SELECT id FROM o.t;\nDROP SCHEMA o CASCADE;\n",
		],
		[
			"a table whose trigger goes and whose trigger function stays",
			"CREATE TABLE t (id int PRIMARY KEY);\nCREATE FUNCTION tf() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;\nCREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION tf();\nDROP TABLE t CASCADE;\n",
		],
	])("baselines a target the files built: %s", async (_, sql) => {
		expect(await built([sql])).toBeUndefined()
	})
})

describe("a Postgres baseline of a kind moved to another schema (P9)", () => {
	it.each([
		"CREATE DOMAIN d AS int;\nCREATE SCHEMA o;\nALTER DOMAIN d SET SCHEMA o;\n",
		"CREATE TYPE c AS (a int);\nCREATE SCHEMA o;\nALTER TYPE c SET SCHEMA o;\n",
		"CREATE TYPE r AS RANGE (subtype = int4);\nCREATE SCHEMA o;\nALTER TYPE r SET SCHEMA o;\n",
		"CREATE COLLATION k (provider = icu, locale = 'und');\nCREATE SCHEMA o;\nALTER COLLATION k SET SCHEMA o;\n",
	])("baselines %j", async (sql) => {
		expect(await built([sql])).toBeUndefined()
	})
})

describe("a Postgres baseline of row level security commands combined in one ALTER (P14)", () => {
	it("baselines ENABLE and FORCE together, among another command", async () => {
		const sql =
			"CREATE TABLE t (id int PRIMARY KEY, a int);\nALTER TABLE t ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, ADD COLUMN b int;\n"
		expect(await built([sql])).toBeUndefined()
	})
})

describe("a Postgres baseline of policy roles as Postgres stores them (P17)", () => {
	it.each(["TO PUBLIC, comb_r19_p17", "TO comb_r19_p17, comb_r19_p17"])("baselines a policy %s", async (to) => {
		await withScratchDb((url) =>
			exec(url, "DO $$ BEGIN CREATE ROLE comb_r19_p17; EXCEPTION WHEN duplicate_object THEN NULL; END $$"),
		)
		const sql = `CREATE TABLE t (id int PRIMARY KEY);\nCREATE POLICY p ON t ${to} USING (true);\n`
		expect(await built([sql])).toBeUndefined()
	})
})

describe("a Postgres baseline whose dev database is reached as another role (reviewer's addition A)", () => {
	it("maps dev's role onto the target's, so a policy TO CURRENT_USER baselines", async () => {
		const role = "comb_r19_dev"
		await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				/* the role logs in with the URL's own password: CI's server checks passwords, a trust server ignores it */
				const password = decodeURIComponent(new URL(dev).password).replaceAll("'", "''")
				await exec(
					dev,
					`DO $$ BEGIN CREATE ROLE ${role} LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$; ALTER ROLE ${role} PASSWORD '${password}'`,
				)
				const database = new URL(dev).pathname.slice(1)
				await exec(dev, `GRANT ALL ON DATABASE "${database}" TO ${role}; GRANT ALL ON SCHEMA public TO ${role};`)
				const sql = "CREATE TABLE t (id int PRIMARY KEY);\nCREATE POLICY p ON t TO CURRENT_USER USING (true);\n"
				await exec(url, sql)
				const other = new URL(dev)
				other.username = role
				expect(await baseline(url, other.toString(), [sql])).toBeUndefined()
			}),
		)
	})
})

describe("a Postgres baseline of a history that holds an index built CONCURRENTLY", () => {
	it("replays it in the one transaction as the index it makes", async () => {
		const files = [
			"CREATE TABLE t (id int PRIMARY KEY, a int);\nCREATE VIEW v AS SELECT a FROM t;\n",
			"-- atlas:txmode none\n\nCREATE INDEX CONCURRENTLY t_a ON t (a);\n",
		]
		expect(await built(files)).toBeUndefined()
	})
})

describe("a Postgres baseline whose replay fails on the dev database", () => {
	it("refuses naming the statement and the dev database's error", async () => {
		const sql = "CREATE TABLE t (id int PRIMARY KEY);\nCREATE VIEW v AS SELECT nope FROM t;\n"
		const refused = await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				await exec(url, "CREATE TABLE t (id int PRIMARY KEY);\nCREATE VIEW v AS SELECT id AS nope FROM t;\n")
				return baseline(url, dev, [sql])
			}),
		)
		expect(refused).toMatch(/CREATE VIEW v AS SELECT nope FROM t.*column "nope" does not exist/s)
	})
})

/* R1 of stack 2: the gate that skips comb's replay for a docker:// dev must miss nothing the catalog read compares */
describe("a Postgres baseline's gate on a docker:// dev database", () => {
	const DO_FUNCTION = "DO $$ BEGIN EXECUTE 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS ''select 1'''; END $$;\n"

	it("refuses, naming devUrl, a history that makes a function inside a DO block, and compares it on a postgres:// dev", async () => {
		const refused = await withScratchDb(async (url) => {
			await exec(url, DO_FUNCTION)
			return baseline(url, "docker://postgres/17/dev", [DO_FUNCTION])
		})
		expect(refused).toMatch(/docker:\/\/postgres\/17\/dev is Atlas's own container, which comb cannot reach/)
		expect(await built([DO_FUNCTION])).toBeUndefined()
	})

	it("compares a serial and identity table's history with no replay, its column-owned sequences being the table's", async () => {
		const sql = "CREATE TABLE t (id serial PRIMARY KEY, n bigint GENERATED ALWAYS AS IDENTITY);\n"
		await withScratchDb(async (url) => {
			await exec(url, sql)
			writeFileSync(join(dir, "20260101000000_t.sql"), sql)
			const target = { devUrl: "docker://postgres/17/dev", lockTimeout: "5s", schema: "public", url }
			const verdict = await refuseObjectDrift({ print: () => undefined, target }, dir)
			expect(verdict()).toEqual([UNCOMPARED])
		})
	})
})
