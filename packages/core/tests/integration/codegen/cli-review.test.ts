/**
 * The 0.9.1 codegen review's run-level findings (F1, F3, F9, F14, F17), through the real CLI on
 * whole projects: what a run writes, what it removes, and whether its output typechecks.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
	codegen,
	exportsOf,
	generatedFiles,
	project,
	read,
	runCodegen,
	typecheck,
	useProjects,
} from "../support/codegen-project.ts"

useProjects()

const SQLITE = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const item = sqliteTable("item", { id: c.id("itm"), name: c.text("name").notNull() })
`

const PG = `import { pgTable } from "drizzle-orm/pg-core"
import { c } from "@lovrozagar/comb/pg/columns"
export const users = pgTable("users", { id: c.id("usr"), age: c.integer("age").notNull(), kind: c.enum("kind", ["a", "b"]).notNull() })
`

describe("a database key that is no identifier (F1)", () => {
	it("writes identifiers camel-cased from it, which typecheck", async () => {
		const dir = project({
			"comb.config.ts": `export default { databases: { "my-db": { tables: "./src/db/tables.ts", dialect: "sqlite", driver: "d1" } } }\n`,
			"src/db/tables.ts": SQLITE,
		})
		await codegen(dir)
		expect(read(dir, "src/db/db.my-db.constraints.gen.ts")).toContain("export const MY_DB_DB_CONSTRAINT_MAP")
		expect(read(dir, "src/db/db.my-db.orm.gen.ts")).toContain("function createMyDbDb(")
		expect(typecheck(dir)).toBe("")
	}, 180_000)

	it("fails, naming the key, when no identifier can be made of it", async () => {
		const dir = project({
			"comb.config.ts": `export default { databases: { "1db": { tables: "./src/db/tables.ts" } } }\n`,
			"src/db/tables.ts": SQLITE,
		})
		const run = await runCodegen(dir)
		expect(run.code).not.toBe(0)
		expect(run.err).toContain('database "1db"')
		expect(generatedFiles(dir)).toEqual([])
	}, 120_000)
})

describe("the neon ORM client under strict (F3)", () => {
	it("types its isolate cache from the driver, so it typechecks", async () => {
		const dir = project({
			"comb.config.ts": `export default { databases: { core: { tables: "./src/db/db.core.tables.ts", dialect: "postgres", driver: "neon" } } }\n`,
			"src/db/db.core.tables.ts": PG,
			/* the package's types, as the review stubbed them: the cache's type must not depend on them */
			"src/stub/neon.d.ts": `declare module "@neondatabase/serverless" {
	export function neon(connectionString: string): any
	export class Pool {
		constructor(options: { connectionString: string })
	}
}
`,
		})
		await codegen(dir)
		expect(typecheck(dir, ["src/stub/neon.d.ts"])).toBe("")
	}, 180_000)
})

describe("direct mode on tables a file re-exports (F9)", () => {
	it("generates for Postgres when the tables it reaches are Postgres tables", async () => {
		const dir = project({ "src/db/db.core.tables.ts": `export * from "./users.ts"\n`, "src/db/users.ts": PG })
		await codegen(dir, ["--tables", "src/db/db.core.tables.ts"])
		expect(read(dir, "src/db/db.core.enum-checks.gen.ts")).toContain('from "drizzle-orm/pg-core"')
		/* the DTOs bound c.integer to int4, shared or inline */
		const dtos = generatedFiles(dir).filter((file) => file.startsWith("src/db/dtos/"))
		expect(dtos.map((file) => read(dir, file)).join("")).toContain(".max(2147483647)")
	}, 120_000)

	it("falls back to the comb columns a tables file imports when its builder is a wrapper", async () => {
		const wrapped = `import { pgTable } from "drizzle-orm/pg-core"
import { c } from "@lovrozagar/comb/pg/columns"
const createTable = pgTable
export const users = createTable("users", { id: c.id("usr"), kind: c.enum("kind", ["a", "b"]).notNull() })
`
		const dir = project({ "src/db/db.core.tables.ts": wrapped })
		await codegen(dir, ["--tables", "src/db/db.core.tables.ts"])
		expect(read(dir, "src/db/db.core.enum-checks.gen.ts")).toContain('from "drizzle-orm/pg-core"')
	}, 120_000)

	it("fails on tables of both dialects", async () => {
		const dir = project({
			"src/db/db.core.tables.ts": `export * from "./users.ts"\nexport * from "./items.ts"\n`,
			"src/db/items.ts": SQLITE,
			"src/db/users.ts": PG,
		})
		const run = await runCodegen(dir, ["--tables", "src/db/db.core.tables.ts"])
		expect(run.code).not.toBe(0)
		expect(run.err).toMatch(/both Postgres and SQLite tables/)
	}, 120_000)
})

/** A config of the core database, with `extra` in its settings */
const config = (extra: string) =>
	`export default { databases: { core: { tables: "./src/db/db.core.tables.ts"${extra} } } }\n`

describe("a run after the prefix or the output moved (F14)", () => {
	it("removes the files the last run wrote under the old prefix", async () => {
		const dir = project({ "comb.config.ts": config(""), "src/db/db.core.tables.ts": SQLITE })
		await codegen(dir)
		expect(generatedFiles(dir).some((file) => path.basename(file).startsWith("db.core."))).toBe(true)
		fs.writeFileSync(path.join(dir, "comb.config.ts"), config(', filePrefix: "app.core"'))
		await codegen(dir)
		const left = generatedFiles(dir).filter((file) => path.basename(file).startsWith("db.core."))
		expect(left).toEqual([])
		expect(generatedFiles(dir).some((file) => path.basename(file).startsWith("app.core."))).toBe(true)
	}, 180_000)

	it("removes the files the last run wrote under the old output root", async () => {
		const dir = project({ "comb.config.ts": config(""), "src/db/db.core.tables.ts": SQLITE })
		await codegen(dir)
		fs.writeFileSync(path.join(dir, "comb.config.ts"), config(', output: { default: "./src/gen" }'))
		await codegen(dir)
		expect(generatedFiles(dir).filter((file) => file.startsWith("src/db/"))).toEqual([])
		expect(generatedFiles(dir).some((file) => file.startsWith("src/gen/"))).toBe(true)
	}, 180_000)
})

describe("a run with one database that fails (F17)", () => {
	it("writes nothing for any database, package.json included", async () => {
		const dir = project({
			"comb.config.ts": `export default { databases: {
	core: { tables: "./src/core/db.core.tables.ts" },
	bad: { tables: "./src/bad/db.bad.tables.ts" },
} }\n`,
			"src/bad/db.bad.tables.ts": `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
const kinds = () => ["a", "b"] as const
export const thing = sqliteTable("thing", { id: c.id("thg"), kind: c.enum("kind", kinds()).notNull() })
`,
			"src/core/db.core.tables.ts": SQLITE,
		})
		const run = await runCodegen(dir)
		expect(run.code).not.toBe(0)
		expect(generatedFiles(dir)).toEqual([])
		expect(exportsOf(dir)).toBeUndefined()
	}, 120_000)
})
