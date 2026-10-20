/**
 * `migrate diff` on Postgres with the real Atlas: each case diffs on a scratch dev database,
 * applies what it wrote to a scratch target in file order (each file one transaction, as Atlas
 * applies it), and diffs again to see the history and the target agree.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { PgTarget } from "../../../src/migrate/core/atlas-target.ts"
import { exportDrizzleSchema } from "../../../src/migrate/core/atlas.ts"
import { generateIncrementalMigration } from "../../../src/migrate/core/migrate-diff.ts"
import { DOCKER_VAR, describeAtlas, dockerDevWanted } from "../support/atlas.ts"
import { describePg, withScratchDb } from "../support/pg.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-diff-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const target = (devUrl: string, schema = "public"): PgTarget => ({ devUrl, lockTimeout: "5s", schema, url: "" })

/** One diff of `schema` into the migrations directory */
const diff = (dev: PgTarget, schema: string, name = "step") =>
	generateIncrementalMigration({
		dialect: "postgres",
		migrationName: name,
		migrationsDir: dir,
		target: dev,
		targetSchema: schema,
	})

/** The files each target database has had applied */
const applied = new Map<string, Set<string>>()

/** Each migration file not yet run on `url` run in name order, one transaction each */
async function applyAll(url: string, searchPath = "public"): Promise<void> {
	const done = applied.get(url) ?? new Set<string>()
	applied.set(url, done)
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		await client.query(`SET search_path TO ${searchPath}`)
		for (const file of readdirSync(dir)
			.filter((f) => f.endsWith(".sql") && !done.has(f))
			.sort()) {
			await client.query(`BEGIN;\n${readFileSync(join(dir, file), "utf8")}\nCOMMIT;`)
			done.add(file)
		}
	} finally {
		await client.end()
	}
}

async function query<T>(url: string, sql: string): Promise<T[]> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		return (await client.query(sql)).rows as T[]
	} finally {
		await client.end()
	}
}

/** Each public table's row level security flags, by name */
const rlsOf = (url: string) =>
	query<{ enabled: boolean; forced: boolean; table: string }>(
		url,
		"SELECT relname AS table, relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname",
	)

/** A hand-written migration `name` added to the history, with atlas.sum rehashed */
function handWritten(name: string, sql: string): void {
	writeFileSync(join(dir, name), sql)
	spawnSync("atlas", ["migrate", "hash", "--dir", `file://${dir}`])
}

/** A scratch dev database and a scratch target for `run` */
const withDevAndTarget = (run: (dev: string, url: string) => Promise<void>) =>
	withScratchDb((dev) => withScratchDb((url) => run(dev, url)))

const POST = 'CREATE TABLE "post" ("id" integer PRIMARY KEY, "title" text NOT NULL);\n'

/** A policy on post with `using` as its condition */
const policy = (using: string) => `CREATE POLICY "own" ON "post" AS PERMISSIVE FOR SELECT TO public USING (${using});\n`

/** An enum of `values` and a post column defaulting to `initial` */
const enumSchema = (values: string, initial: string) =>
	`CREATE TYPE "status" AS ENUM(${values});\nCREATE TABLE "post" ("id" integer PRIMARY KEY, "s" "status" DEFAULT '${initial}'::"status" NOT NULL);\n`

describePg("migrate diff on Postgres: tables, views and policies", () => {
	describeAtlas("with Atlas v1.3.0", () => {
		it("diffs a first migration, finds the history synced, and adds a column", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const dev = target(devUrl)
				expect(diff(dev, POST).files).toHaveLength(1)
				expect(diff(dev, POST, "again")).toEqual({ files: [], synced: true })
				const [added] = diff(dev, POST.replace("NOT NULL)", 'NOT NULL, "body" text)'), "body").files
				expect(readFileSync(added as string, "utf8")).toContain('ADD COLUMN "body" text')
				await applyAll(url)
				expect(
					await query(url, "SELECT column_name FROM information_schema.columns WHERE table_name = 'post' ORDER BY 1"),
				).toEqual([{ column_name: "body" }, { column_name: "id" }, { column_name: "title" }])
			})
		}, 60_000)

		it("drops and recreates a view around Atlas's retype of a column it reads, so the file applies", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const dev = target(devUrl)
				const view = 'CREATE VIEW "titles" AS (select "title" from "post");\n'
				diff(dev, POST + view)
				const [retyped] = diff(dev, POST.replace('"title" text', '"title" varchar(50)') + view, "retype").files
				expect(readFileSync(retyped as string, "utf8")).toMatch(
					/^DROP VIEW IF EXISTS "titles";[\s\S]*TYPE character varying\(50\)[\s\S]*CREATE VIEW "titles"/,
				)
				await applyAll(url)
				expect(await query(url, "SELECT count(*)::int AS n FROM titles")).toEqual([{ n: 0 }])
				expect(diff(dev, POST.replace('"title" text', '"title" varchar(50)') + view, "again").synced).toBe(true)
			})
		}, 60_000)

		it("diffs a policy on a table with row level security, and its change", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const dev = target(devUrl)
				const rls = `${POST}ALTER TABLE "post" ENABLE ROW LEVEL SECURITY;\n`
				diff(dev, rls + policy("true"))
				expect(diff(dev, rls + policy("true"), "again").synced).toBe(true)
				const [changed] = diff(dev, rls + policy('"post"."id" > 0'), "narrow").files
				expect(readFileSync(changed as string, "utf8")).toBe(
					`DROP POLICY IF EXISTS "own" ON "post";\n\n${policy('"post"."id" > 0').trimEnd()}\n`,
				)
				await applyAll(url)
				expect(await query(url, "SELECT polname, pg_get_expr(polqual, polrelid) AS qual FROM pg_policy")).toEqual([
					{ polname: "own", qual: "(id > 0)" },
				])
				expect(await rlsOf(url)).toEqual([{ enabled: true, forced: false, table: "post" }])
				expect(diff(dev, rls + policy('"post"."id" > 0'), "applied").synced).toBe(true)
			})
		}, 60_000)
	})
})

describePg("migrate diff on Postgres: row level security", () => {
	describeAtlas("with Atlas v1.3.0", () => {
		it("enables row level security without a policy, and forces it", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const dev = target(devUrl)
				const enabled = `${POST}ALTER TABLE "post" ENABLE ROW LEVEL SECURITY;\n`
				diff(dev, enabled)
				expect(diff(dev, enabled, "again").synced).toBe(true)
				const forced = `${enabled}ALTER TABLE "post" FORCE ROW LEVEL SECURITY;\n`
				const [force] = diff(dev, forced, "force").files
				expect(readFileSync(force as string, "utf8")).toBe('ALTER TABLE "post" FORCE ROW LEVEL SECURITY;\n')
				expect(diff(dev, forced, "forced").synced).toBe(true)
				await applyAll(url)
				expect(await rlsOf(url)).toEqual([{ enabled: true, forced: true, table: "post" }])
				const [off] = diff(dev, POST, "off").files
				expect(readFileSync(off as string, "utf8")).toBe(
					'ALTER TABLE "post" DISABLE ROW LEVEL SECURITY;\n\nALTER TABLE "post" NO FORCE ROW LEVEL SECURITY;\n',
				)
				await applyAll(url)
				expect(await rlsOf(url)).toEqual([{ enabled: false, forced: false, table: "post" }])
				expect(diff(dev, POST, "plain").synced).toBe(true)
			})
		}, 90_000)

		it("drops a table with row level security, then creates it again with its policy", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const dev = target(devUrl)
				const team = 'CREATE TABLE "team" ("id" integer PRIMARY KEY);\n'
				const secured = `${POST}ALTER TABLE "post" ENABLE ROW LEVEL SECURITY;\n${policy("true")}`
				diff(dev, team + secured)
				const [dropped] = diff(dev, team, "drop").files
				expect(readFileSync(dropped as string, "utf8")).not.toMatch(/ROW LEVEL SECURITY/)
				expect(diff(dev, team, "gone").synced).toBe(true)
				diff(dev, team + secured, "back")
				expect(diff(dev, team + secured, "again").synced).toBe(true)
				await applyAll(url)
				expect(await rlsOf(url)).toEqual([
					{ enabled: true, forced: false, table: "post" },
					{ enabled: false, forced: false, table: "team" },
				])
				expect(await query(url, "SELECT polname FROM pg_policy")).toEqual([{ polname: "own" }])
			})
		}, 90_000)
	})
})

describePg("migrate diff on Postgres: row level security across renames and drops", () => {
	describeAtlas("with Atlas v1.3.0", () => {
		it("secures the table a rename creates, as Atlas writes a rename as a create and a drop", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const dev = target(devUrl)
				diff(dev, `${POST}ALTER TABLE "post" ENABLE ROW LEVEL SECURITY;\n${policy("true")}`)
				const article = `${POST.replace('"post"', '"article"')}ALTER TABLE "article" ENABLE ROW LEVEL SECURITY;\n${policy("true").replace('"post"', '"article"')}`
				const [renamed] = diff(dev, article, "rename").files
				expect(readFileSync(renamed as string, "utf8")).toMatch(/ALTER TABLE "article" ENABLE ROW LEVEL SECURITY;/)
				expect(diff(dev, article, "again").synced).toBe(true)
				await applyAll(url)
				expect(await rlsOf(url)).toEqual([{ enabled: true, forced: false, table: "article" }])
				expect(await query(url, "SELECT polname, polrelid::regclass::text AS rel FROM pg_policy")).toEqual([
					{ polname: "own", rel: "article" },
				])
			})
		}, 90_000)

		it("follows a hand-written rename of a secured table in the history", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const dev = target(devUrl)
				diff(dev, `${POST}ALTER TABLE "post" ENABLE ROW LEVEL SECURITY;\n${policy("true")}`)
				handWritten(
					"20990101000000_rename.sql",
					'ALTER TABLE "post" RENAME TO "article";\nALTER TABLE "article" RENAME CONSTRAINT "post_pkey" TO "article_pkey";\n',
				)
				const article = `${POST.replace('"post"', '"article"')}ALTER TABLE "article" ENABLE ROW LEVEL SECURITY;\n${policy("true").replace('"post"', '"article"')}`
				expect(diff(dev, article, "after").synced).toBe(true)
				await applyAll(url)
				expect(await rlsOf(url)).toEqual([{ enabled: true, forced: false, table: "article" }])
			})
		}, 90_000)

		it("creates a policy again after a hand-written drop of its table", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const dev = target(devUrl)
				const secured = `${POST}ALTER TABLE "post" ENABLE ROW LEVEL SECURITY;\n${policy("true")}`
				diff(dev, secured)
				handWritten("20990101000000_drop.sql", 'DROP TABLE "post";\n')
				diff(dev, secured, "back")
				expect(diff(dev, secured, "again").synced).toBe(true)
				await applyAll(url)
				expect(await rlsOf(url)).toEqual([{ enabled: true, forced: false, table: "post" }])
				expect(await query(url, "SELECT polname FROM pg_policy")).toEqual([{ polname: "own" }])
			})
		}, 90_000)
	})
})

describePg("migrate diff on Postgres: extensions, enums and schemas", () => {
	describeAtlas("with Atlas v1.3.0", () => {
		it("diffs an extension's type on a persistent dev database that has the extension", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				await query(devUrl, "CREATE EXTENSION citext")
				writeFileSync(join(dir, "20260101000000_citext.sql"), "CREATE EXTENSION IF NOT EXISTS citext;\n")
				spawnSync("atlas", ["migrate", "hash", "--dir", `file://${dir}`])
				const dev = target(devUrl)
				const schema = 'CREATE TABLE "account" ("email" citext PRIMARY KEY);\n'
				expect(diff(dev, schema).files).toHaveLength(1)
				expect(diff(dev, schema, "again").synced).toBe(true)
				await applyAll(url)
				expect(await query(url, "SELECT pg_typeof(email)::text AS t FROM (SELECT 'A'::citext AS email) s")).toEqual([
					{ t: "citext" },
				])
			})
		}, 60_000)

		it("writes an added enum value into a file before the one whose default uses it, and both apply", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				const dev = target(devUrl)
				diff(dev, enumSchema("'draft'", "draft"))
				const files = diff(dev, enumSchema("'draft', 'archived'", "archived"), "archive").files
				expect(files.map((file) => file.slice(-30))).toEqual([
					expect.stringMatching(/_archive_enum_values\.sql$/),
					expect.stringMatching(/\d_archive\.sql$/),
				])
				await applyAll(url)
				expect(diff(dev, enumSchema("'draft', 'archived'", "archived"), "again").synced).toBe(true)
			})
		}, 60_000)

		it("migrates a schema other than public, which both databases must have", async () => {
			await withDevAndTarget(async (devUrl, url) => {
				for (const db of [devUrl, url]) await query(db, "CREATE SCHEMA app")
				const dev = target(devUrl, "app")
				expect(diff(dev, 'CREATE TABLE "app"."post" ("id" integer PRIMARY KEY);\n').files).toHaveLength(1)
				await applyAll(url, "app")
				expect(
					await query(url, "SELECT table_schema FROM information_schema.tables WHERE table_name = 'post'"),
				).toEqual([{ table_schema: "app" }])
			})
		}, 60_000)
	})
})

describe("migrate diff on Postgres: the drizzle export", () => {
	const core = join(import.meta.dirname, "../../..")
	let work = ""
	beforeEach(() => {
		/* inside the package, so drizzle-orm and drizzle-kit resolve from its dependencies */
		work = join(core, `.tmp-pg-export-${process.pid}`)
		mkdirSync(work, { recursive: true })
	})
	afterEach(() => rmSync(work, { force: true, recursive: true }))

	it("refuses a drizzle schema with an object outside the database's schema, on drizzle-kit's real export", () => {
		writeFileSync(
			join(work, "schema.ts"),
			'import { integer, pgSchema, pgTable, uuid } from "drizzle-orm/pg-core"\nexport const auth = pgSchema("auth")\nexport const users = auth.table("users", { id: uuid("id").primaryKey() })\nexport const post = pgTable("post", { id: integer("id").primaryKey(), author: uuid("author").references(() => users.id) })\n',
		)
		writeFileSync(
			join(work, "drizzle.config.ts"),
			`export default { dialect: "postgresql", schema: "${join(work, "schema.ts")}" }\n`,
		)
		expect(() =>
			exportDrizzleSchema({ configPath: join(work, "drizzle.config.ts"), cwd: core, dialect: "postgres" }),
		).toThrow('the drizzle schema creates objects outside schema "public"')
	}, 60_000)
})

const docker = dockerDevWanted()

/** Probes for whether docker runs */
const yes = () => true
const no = () => false

describe("dockerDevWanted", () => {
	it("runs the docker:// case locally only when COMB_TEST_DOCKER=1, since its containers disturb other sessions", () => {
		expect(dockerDevWanted({}, yes)).toBe(false)
		expect(dockerDevWanted({ [DOCKER_VAR]: "1" }, yes)).toBe(true)
		expect(dockerDevWanted({ [DOCKER_VAR]: "1" }, no)).toBe(false)
	})

	it("runs it in CI, where Docker must work", () => {
		expect(dockerDevWanted({ CI: "true" }, yes)).toBe(true)
		expect(() => dockerDevWanted({ CI: "true" }, no)).toThrow("docker must run in CI")
	})
})

describePg("migrate diff on Postgres: the default dev database", () => {
	describeAtlas("with Atlas v1.3.0", () => {
		it.skipIf(!docker)(
			"diffs on docker://postgres/17/dev, Atlas's own throwaway container",
			() => {
				expect(diff(target("docker://postgres/17/dev"), POST).files).toHaveLength(1)
			},
			180_000,
		)
	})
})
