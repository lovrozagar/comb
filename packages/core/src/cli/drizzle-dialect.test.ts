import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Run } from "../migrate/core/process.ts"
import { fakeAtlas as syncedAtlas } from "./__fixtures__/d1.ts"
import { makeIo, projects } from "./__fixtures__/io.ts"
import { checkDialect, literalDialect, statedDialect } from "./drizzle-dialect.ts"
import { runCli } from "./run.ts"

const temp = projects()
const project = temp.make
afterEach(temp.clean)

/** Atlas and drizzle-kit, faked with a synced schema, and each call they took */
function fakeAtlas(): Run & { calls: string[][] } {
	const calls: string[][] = []
	const inner = syncedAtlas()
	const run: Run = (cmd, args) => {
		calls.push([cmd, ...args])
		return inner(cmd, args)
	}
	return Object.assign(run, { calls })
}

/** comb.migrate.config.ts declaring core on `provider`, its migrations in m/ */
const coreOn = (provider: string) =>
	`export default { databases: { core: { migrationsDir: "m", name: "core", provider: ${provider} } } }\n`
const PG_CORE = coreOn('{ devUrl: "postgres://localhost/dev", type: "postgres", url: "postgres://localhost/app" }')
const LIBSQL_CORE = coreOn('{ type: "libsql", url: "file:core.db" }')

/** A diff of core whose drizzle config states `dialect`, and what it ran and wrote */
async function diffWith(config: string, dialect: string | undefined) {
	const dir = project()
	const stated = dialect === undefined ? "{}" : `{ dialect: ${JSON.stringify(dialect)} }`
	writeFileSync(join(dir, "drizzle.config.ts"), `export default ${stated}\n`)
	writeFileSync(join(dir, "comb.migrate.config.ts"), config)
	const atlas = fakeAtlas()
	const io = makeIo(dir, atlas)
	const code = await runCli(["migrate", "diff", "core", "next"], io)
	return {
		code,
		dir,
		drizzleKit: atlas.calls.filter((call) => call[0] === "bun"),
		errors: io.errors,
		wrote: existsSync(join(dir, "m")),
	}
}

/* KC1 of r22b: drizzle-kit exports none of the other dialect's tables, so 0.20's diff wrote DROP TABLE for each, exit 0 */
describe("diff refuses a drizzle config of the other dialect (KC1; sibling: init over an init of the other dialect)", () => {
	it("refuses a sqlite drizzle config for a Postgres database, naming the file and both dialects, before drizzle-kit runs", async () => {
		const { code, dir, drizzleKit, errors, wrote } = await diffWith(PG_CORE, "sqlite")
		expect(code).toBe(1)
		expect(errors).toEqual([
			`${join(dir, "drizzle.config.ts")} states dialect "sqlite", but database core is Postgres: set dialect: "postgresql" in it, or set drizzleConfigPath on core in comb.migrate.config.ts to a Postgres drizzle config`,
		])
		expect({ drizzleKit, wrote }).toEqual({ drizzleKit: [], wrote: false })
	})

	it("refuses a postgresql drizzle config for a SQLite database, and one that states no dialect", async () => {
		const pg = await diffWith(LIBSQL_CORE, "postgresql")
		expect(pg.errors).toEqual([
			`${join(pg.dir, "drizzle.config.ts")} states dialect "postgresql", but database core is SQLite: set dialect: "sqlite" in it, or set drizzleConfigPath on core in comb.migrate.config.ts to a SQLite drizzle config`,
		])
		expect({ drizzleKit: pg.drizzleKit, wrote: pg.wrote }).toEqual({ drizzleKit: [], wrote: false })
		const none = await diffWith(LIBSQL_CORE, undefined)
		expect(none.errors).toEqual([
			`${join(none.dir, "drizzle.config.ts")} states no dialect, but database core is SQLite: set dialect: "sqlite" in it, or set drizzleConfigPath on core in comb.migrate.config.ts to a SQLite drizzle config`,
		])
	})

	it("takes turso as a SQLite dialect, and sqlite for a diff with no comb.migrate.config.ts", async () => {
		const turso = await diffWith(LIBSQL_CORE, "turso")
		expect({ code: turso.code, errors: turso.errors }).toEqual({ code: 0, errors: [] })
		const dir = project()
		writeFileSync(join(dir, "drizzle.config.ts"), 'export default { dialect: "postgresql" }\n')
		const bare = makeIo(dir, fakeAtlas())
		expect(await runCli(["migrate", "diff"], bare)).toBe(1)
		expect(bare.errors).toEqual([
			`${join(dir, "drizzle.config.ts")} states dialect "postgresql", but a diff with no comb.migrate.config.ts is SQLite: set dialect: "sqlite" in it`,
		])
	})

	it("refuses init --dialect postgres over a SQLite init, and the reverse, naming the file and writing nothing", async () => {
		const dir = project()
		expect(await runCli(["migrate", "init"], makeIo(dir))).toBe(0)
		const pg = makeIo(dir)
		expect(await runCli(["migrate", "init", "--dialect", "postgres"], pg)).toBe(1)
		expect(pg.errors).toEqual([
			`${join(dir, "drizzle.config.ts")} states dialect "sqlite", but migrate init --dialect postgres writes a Postgres project: set dialect: "postgresql" in it, or remove it and run init again`,
		])
		expect(readdirSync(dir).sort()).toEqual(["atlas-migrations", "drizzle.config.ts"])
		const other = project()
		expect(await runCli(["migrate", "init", "--dialect", "postgres"], makeIo(other))).toBe(0)
		const sqlite = makeIo(other)
		expect(await runCli(["migrate", "init"], sqlite)).toBe(1)
		expect(sqlite.errors).toEqual([
			`${join(other, "drizzle.config.ts")} states dialect "postgresql", but migrate init --dialect sqlite writes a SQLite project: set dialect: "sqlite" in it, or remove it and run init again`,
		])
	})
})

describe("the dialect a drizzle config states", () => {
	it("reads a .json config, and a module with no default export as stating none", async () => {
		const dir = project()
		writeFileSync(join(dir, "drizzle.config.json"), '{ "dialect": "turso" }')
		writeFileSync(join(dir, "drizzle.config.mjs"), "export const dialect = 'sqlite'\n")
		expect(await statedDialect(join(dir, "drizzle.config.json"))).toBe("turso")
		expect(await statedDialect(join(dir, "drizzle.config.mjs"))).toBeUndefined()
	})

	it("reads a literal dialect from the source init finds, and none from one that computes it", () => {
		expect(literalDialect('defineConfig({\n\tdialect: "postgresql",\n})')).toBe("postgresql")
		expect(literalDialect("export default { dialect: 'sqlite' }")).toBe("sqlite")
		expect(literalDialect("export default { dialect: process.env.DIALECT }")).toBeUndefined()
	})

	it("names a dialect that is not a string as the config states it", () => {
		expect(() => checkDialect("drizzle.config.json", 5, { but: "database core is SQLite", dialect: "sqlite" })).toThrow(
			'drizzle.config.json states dialect 5, but database core is SQLite: set dialect: "sqlite" in it',
		)
	})
})
