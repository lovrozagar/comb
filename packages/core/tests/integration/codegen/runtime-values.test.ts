/**
 * The 0.12 codegen review's findings on values (F1–F4, F19): a bound, an enum list or an id prefix
 * is what the tables module computes at runtime, however its source spells it, through the CLI
 */
import path from "node:path"
import type * as z from "zod"
import { describe, expect, it } from "vitest"
import { codegen, project, read, runCodegen, useProjects } from "../support/codegen-project.ts"

useProjects()

const HEAD = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
`
const CONFIG = `export default { databases: { core: { tables: "./src/db/db.core.tables.ts" } } }\n`

/** A project of `tables` (after the imports) and `files` beside it, codegen run */
async function generated(tables: string, files: Record<string, string> = {}): Promise<string> {
	const dir = project({ "comb.config.ts": CONFIG, "src/db/db.core.tables.ts": `${HEAD}${tables}\n`, ...files })
	await codegen(dir)
	return dir
}

/** The generated create DTO of `entity` (its kebab-case name) */
async function createOf(dir: string, entity: string, name: string): Promise<z.ZodObject> {
	const dtos = (await import(path.join(dir, `src/db/dtos/${entity}/db.core.${entity}.gen.ts`))) as Record<
		string,
		z.ZodObject
	>
	return dtos[`${name}DtoCreateSchema`] as z.ZodObject
}

const accepts = (schema: z.ZodObject, value: unknown) => schema.safeParse(value).success

describe("an enum member's initializer naming another member (F1)", () => {
	it("bounds by the member, as runtime reads it, not by a const of that name", async () => {
		const dir = await generated(`export const SHORT = 99
export enum Lim { SHORT = 5, NAME = SHORT }
export const item = sqliteTable("item", { id: c.id("itm"), name: c.text("name", { max: Lim.NAME }) })`)
		const create = await createOf(dir, "item", "item")
		expect(accepts(create, { name: "abcde" })).toBe(true)
		expect(accepts(create, { name: "abcdef" })).toBe(false)
	}, 120_000)
})

describe("an object a spread overrides (F2)", () => {
	it("bounds and lists enum values as the spread leaves them", async () => {
		const dir = await generated(`const OVERRIDE = { MAX: 10 }
const LIM = { MAX: 200, ...OVERRIDE }
const MORE = { STATES: ["draft", "live", "archived"] as const }
const ENUMS = { STATES: ["draft", "live"] as const, ...MORE }
export const item = sqliteTable("item", { id: c.id("itm"), name: c.text("name", { max: LIM.MAX }), state: c.enum("state", ENUMS.STATES) })`)
		const create = await createOf(dir, "item", "item")
		expect(accepts(create, { name: "x".repeat(11) })).toBe(false)
		expect(accepts(create, { name: "x".repeat(10), state: "archived" })).toBe(true)
		expect(read(dir, "src/db/db.core.enum-checks.gen.ts")).toContain("'archived'")
	}, 120_000)
})

describe("a constraint object passed by name (F3)", () => {
	it("applies every bound and pattern it holds", async () => {
		const dir = await generated(`const NAME_RULES = { max: 5, pattern: "/^[a-z]+$/" } as const
export const item = sqliteTable("item", { id: c.id("itm"), name: c.text("name", NAME_RULES) })`)
		const create = await createOf(dir, "item", "item")
		expect(accepts(create, { name: "abc" })).toBe(true)
		expect(accepts(create, { name: "abcdefghijklmnop" })).toBe(false)
		expect(accepts(create, { name: "ABC" })).toBe(false)
	}, 120_000)
})

describe("enum values through a paths alias, a namespace or a default import (F4)", () => {
	const lib = { "src/lib/enums.ts": `export const STATES = ["draft", "live"] as const\nexport default { STATES }\n` }

	it("checks the values imported through a tsconfig paths alias", async () => {
		const dir = await generated(
			`import { STATES } from "@lib/enums"
export const item = sqliteTable("item", { id: c.id("itm"), status: c.enum("status", STATES) })`,
			{
				...lib,
				"tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["./src/lib/*"] } } }),
			},
		)
		expect(read(dir, "src/db/db.core.enum-checks.gen.ts")).toContain("IN ('draft', 'live')")
		expect(read(dir, "src/db/db.core.constraints.gen.ts")).toContain("item_status_enum")
	}, 120_000)

	it("checks the values read through a namespace and a default import", async () => {
		const dir = await generated(
			`import * as L from "../lib/enums.ts"
import Def from "../lib/enums.ts"
export const item = sqliteTable("item", { id: c.id("itm"), a: c.enum("a", L.STATES), b: c.enum("b", Def.STATES) })`,
			lib,
		)
		const checks = read(dir, "src/db/db.core.enum-checks.gen.ts")
		expect(checks).toContain("item_a_enum")
		expect(checks).toContain("item_b_enum")
	}, 120_000)
})

describe("an id prefix held by a const (F19)", () => {
	it("is the table's prefix, so it gets generateId and its example", async () => {
		const dir = await generated(`const USER_PREFIX = "usr"
export const user = sqliteTable("user", { id: c.id(USER_PREFIX) })`)
		expect(read(dir, "src/db/db.core.entities.gen.ts")).toContain('user: "usr"')
	}, 120_000)

	it("is refused when another table's prefix is the same", async () => {
		const dir = project({
			"comb.config.ts": CONFIG,
			"src/db/db.core.tables.ts": `${HEAD}const USER_PREFIX = "usr"
export const user = sqliteTable("user", { id: c.id(USER_PREFIX) })
export const team = sqliteTable("team", { id: c.id("usr") })
`,
		})
		const run = await runCodegen(dir)
		expect(run.code).not.toBe(0)
		expect(run.err).toMatch(/usr/)
	}, 120_000)
})
