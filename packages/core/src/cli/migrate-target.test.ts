import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { projects } from "./__fixtures__/io.ts"
import { resolveMigrateTarget } from "./migrate-target.ts"

const temp = projects()
afterEach(temp.clean)

const PG = { type: "postgres", url: "postgres://app@db.example.com/app?sslmode=verify-full" }
const LITE = { type: "libsql", url: "file:core.db" }

/** A project whose comb.migrate.config.ts (in ./db) declares `databases`, and optionally a comb.config.ts */
function project(databases: Record<string, unknown>, combConfig?: string): string {
	const dir = temp.make()
	mkdirSync(join(dir, "db"))
	writeFileSync(join(dir, "comb.migrate.config.ts"), `export default { databases: ${JSON.stringify(databases)} }\n`)
	if (combConfig !== undefined) writeFileSync(join(dir, "comb.config.ts"), combConfig)
	return dir
}

/** A comb.config.ts giving database `db` an FTS5 table */
const fts = (db: string) =>
	`export default { databases: { ${db}: { tables: "t.ts", fts: { post_fts: { columns: ["title"] } } } } }\n`

describe("resolveMigrateTarget", () => {
	it("is undefined in a project without comb.migrate.config.ts", async () => {
		expect(await resolveMigrateTarget({ cwd: temp.make(), db: "core", mode: "diff" })).toBeUndefined()
	})

	it("resolves a Postgres database with its dialect, defaults and paths against the config", async () => {
		const cwd = project({
			core: { drizzleConfigPath: "drizzle.pg.ts", migrationsDir: "db/pg", name: "core", provider: PG },
		})
		expect(await resolveMigrateTarget({ cwd, db: "core", mode: "diff" })).toEqual({
			codegen: "core",
			configDir: cwd,
			database: "core",
			dialect: "postgres",
			drizzleConfigPath: join(cwd, "drizzle.pg.ts"),
			label: "core (core)",
			migrationsDir: join(cwd, "db/pg"),
			name: "core",
			provider: { devUrl: "docker://postgres/17/dev", lockTimeout: "5s", schema: "public", ...PG },
		})
	})

	it("takes --dir over the configured directory, and leaves drizzleConfigPath unset when the config does", async () => {
		const cwd = project({ core: { migrationsDir: "m", name: "core", provider: LITE } })
		const target = await resolveMigrateTarget({ cwd, db: "core", dir: "other", mode: "apply" })
		expect(target).toMatchObject({ dialect: "sqlite", drizzleConfigPath: undefined, migrationsDir: join(cwd, "other") })
	})

	it("diffs without -e, from the database's provider or its first environment's, and applies only with it", async () => {
		const environments = {
			prod: { name: "core-prod", provider: { ...PG, url: "postgres://p/app" } },
			staging: { name: "core-staging" },
		}
		const cwd = project({ core: { environments, migrationsDir: "m", provider: PG } })
		expect(await resolveMigrateTarget({ cwd, db: "core", mode: "diff" })).toMatchObject({ label: "core (core-prod)" })
		expect(await resolveMigrateTarget({ cwd, db: "core", env: "staging", mode: "apply" })).toMatchObject({
			label: "core (core-staging)",
			provider: PG,
		})
		await expect(resolveMigrateTarget({ cwd, db: "core", mode: "apply" })).rejects.toThrow(
			"pass -e/--env with one of: prod, staging",
		)
	})
})

describe("resolveMigrateTarget refusals", () => {
	it("refuses a database whose environments mix dialects", async () => {
		const environments = { local: { name: "l", provider: LITE }, prod: { name: "p", provider: PG } }
		const cwd = project({ core: { environments, migrationsDir: "m" } })
		await expect(resolveMigrateTarget({ cwd, db: "core", mode: "diff" })).rejects.toThrow(
			'database "core" mixes sqlite and postgres environments; one database has one dialect',
		)
	})

	it("resolves a SQLite and a Postgres database of one config, each with its own dialect", async () => {
		const cwd = project({
			analytics: { migrationsDir: "pg", name: "analytics", provider: PG },
			core: { migrationsDir: "m", name: "core", provider: LITE },
		})
		expect((await resolveMigrateTarget({ cwd, db: "analytics", mode: "diff" }))?.dialect).toBe("postgres")
		expect((await resolveMigrateTarget({ cwd, db: "core", mode: "diff" }))?.dialect).toBe("sqlite")
	})

	it("names the databases when the config declares none by that name", async () => {
		const cwd = project({ core: { migrationsDir: "m", name: "core", provider: LITE } })
		await expect(resolveMigrateTarget({ cwd, db: "blog", mode: "diff" })).rejects.toThrow(
			'comb.migrate.config.ts declares no database "blog". Available: core',
		)
	})

	it("refuses FTS5 tables on a Postgres database, and allows them on SQLite", async () => {
		const pg = project({ core: { migrationsDir: "m", name: "core", provider: PG } }, fts("core"))
		await expect(resolveMigrateTarget({ cwd: pg, db: "core", mode: "diff" })).rejects.toThrow(
			'comb.config.ts gives the Postgres database "core" FTS5 tables, which are SQLite; use a tsvector column with a GIN index',
		)
		const lite = project({ core: { migrationsDir: "m", name: "core", provider: LITE } }, fts("core"))
		expect((await resolveMigrateTarget({ cwd: lite, db: "core", mode: "diff" }))?.dialect).toBe("sqlite")
	})
})
