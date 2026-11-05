/**
 * PA6 of r22b, by kind: a schema beside public's shared history is migrated as empty only while it
 * holds nothing. Holding anything a migration can place in a schema, of any kind, is holding
 * something, so its files go to adoption and its proof rather than running again. Default
 * privileges a person set on the schema are no object in it, and a schema holding only them is empty.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { statusWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { run } from "../../../src/migrate/core/process.ts"
import { withScratchDb } from "../support/pg.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-adopt-kinds-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const A = "20260101000010_a.sql"
const B = "20260101000020_b.sql"

/** What 0.12 did for public: Atlas applies A and B with their history in the shared atlas_schema_revisions */
async function publicMigrated(url: string): Promise<void> {
	writeFileSync(join(dir, A), 'CREATE TABLE "a" ("id" integer);\n')
	writeFileSync(join(dir, B), 'CREATE TABLE "b" ("id" integer);\n')
	await hashDir(run, dir)
	const args = [
		"migrate",
		"apply",
		"--url",
		url,
		"--dir",
		`file://${dir}`,
		"--revisions-schema",
		"atlas_schema_revisions",
	]
	const ran = spawnSync("atlas", args, { encoding: "utf8" })
	if (ran.status !== 0) throw new Error(`atlas migrate apply: ${ran.stderr}${ran.stdout}`)
}

async function query(url: string, sql: string): Promise<void> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		await client.query(sql)
	} finally {
		await client.end()
	}
}

// lookup-table: each kind a migration can place in a schema, made alone in schema `s`
const KINDS: Readonly<Record<string, (s: string) => string>> = {
	aggregate: (s) => `CREATE AGGREGATE ${s}.agg (integer) (SFUNC = int4pl, STYPE = integer)`,
	collation: (s) => `CREATE COLLATION ${s}.col FROM "C"`,
	"composite type": (s) => `CREATE TYPE ${s}.c AS (x integer)`,
	conversion: (s) => `CREATE CONVERSION ${s}.conv FOR 'LATIN1' TO 'UTF8' FROM iso8859_1_to_utf8`,
	domain: (s) => `CREATE DOMAIN ${s}.d AS integer`,
	enum: (s) => `CREATE TYPE ${s}.e AS ENUM ('a')`,
	"foreign table": (s) => `CREATE FOREIGN TABLE ${s}.ft (x integer) SERVER srv`,
	function: (s) => `CREATE FUNCTION ${s}.f() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
	"function left by a dropped table": (s) =>
		`CREATE TABLE ${s}.t (id integer); CREATE FUNCTION ${s}.g() RETURNS integer LANGUAGE sql AS 'SELECT 1'; DROP TABLE ${s}.t`,
	"materialized view": (s) => `CREATE MATERIALIZED VIEW ${s}.m AS SELECT 1 AS x`,
	operator: (s) => `CREATE OPERATOR ${s}.=== (LEFTARG = integer, RIGHTARG = integer, FUNCTION = int4eq)`,
	procedure: (s) => `CREATE PROCEDURE ${s}.p() LANGUAGE sql AS 'SELECT 1'`,
	"range type": (s) => `CREATE TYPE ${s}.r AS RANGE (SUBTYPE = float8)`,
	sequence: (s) => `CREATE SEQUENCE ${s}.q`,
	"statistics object on public's table": (s) => `CREATE STATISTICS ${s}.st ON id, n FROM public.stats`,
	"text search configuration": (s) => `CREATE TEXT SEARCH CONFIGURATION ${s}.tsc (COPY = pg_catalog.simple)`,
	"text search dictionary": (s) => `CREATE TEXT SEARCH DICTIONARY ${s}.tsd (TEMPLATE = pg_catalog.simple)`,
	view: (s) => `CREATE VIEW ${s}.v AS SELECT 1 AS x`,
}

/** What status lists as pending for schema `schema` of `url`, and whether it said public's rows are another schema's */
async function pendingIn(url: string, schema: string): Promise<{ pending: string[]; theirs: boolean }> {
	const out: string[] = []
	const target = { devUrl: "postgres://comb-no-dev.invalid/dev", lockTimeout: "5s", schema, url }
	const { pending } = await statusWithAtlas({ dir, print: (line) => out.push(line), target })
	return { pending, theirs: out.some((line) => line.includes("are another schema's")) }
}

describe("migrate status on Postgres: a schema beside public's history holding one kind alone (PA6; sibling: empty schema)", () => {
	describe("with Atlas v1.3.0", () => {
		it("goes to adoption, not to running its files again, whatever the kind it holds", async () => {
			await withScratchDb(async (url) => {
				await publicMigrated(url)
				await query(
					url,
					"CREATE FOREIGN DATA WRAPPER w; CREATE SERVER srv FOREIGN DATA WRAPPER w; CREATE TABLE public.stats (id integer, n integer)",
				)
				const seen: Record<string, { pending: string[]; theirs: boolean }> = {}
				for (const [index, [kind, make]] of Object.entries(KINDS).entries()) {
					const schema = `k${index}`
					await query(url, `CREATE SCHEMA ${schema}; ${make(schema)}`)
					seen[kind] = await pendingIn(url, schema)
				}
				const adopting = Object.fromEntries(Object.keys(KINDS).map((kind) => [kind, { pending: [], theirs: false }]))
				expect(seen).toEqual(adopting)
			})
		}, 120_000)

		it("migrates as empty a schema holding only default privileges, which are no object in it", async () => {
			await withScratchDb(async (url) => {
				await publicMigrated(url)
				await query(url, "CREATE SCHEMA app; ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO PUBLIC")
				expect(await pendingIn(url, "app")).toEqual({ pending: [A, B], theirs: true })
			})
		}, 60_000)
	})
})
