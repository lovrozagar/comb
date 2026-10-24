/**
 * The 0.12 codegen review's findings on table shapes (F6–F8, F12–F14, F16–F18, F24): every table
 * the module exports, every column typed and every constraint mapped as drizzle builds it at
 * runtime, however its source spells it, through the CLI
 */
import fs from "node:fs"
import path from "node:path"
import type * as z from "zod"
import { describe, expect, it } from "vitest"
import { codegen, project, read, useProjects } from "../support/codegen-project.ts"

useProjects()

const HEAD = {
	postgres: `import { pgTable } from "drizzle-orm/pg-core"
import { c } from "@lovrozagar/comb/pg/columns"
`,
	sqlite: `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
`,
}
const config = (dialect: "postgres" | "sqlite") =>
	`export default { databases: { core: { tables: "./src/db/db.core.tables.ts"${dialect === "postgres" ? ', dialect: "postgres"' : ""} } } }\n`

type Options = { dialect?: "postgres" | "sqlite"; files?: Record<string, string>; head?: boolean }

/** A project of `tables` and `files` beside it, codegen run */
async function generated(tables: string, { dialect = "sqlite", files = {}, head = true }: Options = {}) {
	const source = `${head ? HEAD[dialect] : ""}${tables}\n`
	const dir = project({ "comb.config.ts": config(dialect), "src/db/db.core.tables.ts": source, ...files })
	await codegen(dir)
	return dir
}

/** The generated DTO schemas of `entity` (its kebab-case name) */
async function dtosOf(dir: string, entity: string): Promise<Record<string, z.ZodObject>> {
	return (await import(path.join(dir, `src/db/dtos/${entity}/db.core.${entity}.gen.ts`))) as Record<string, z.ZodObject>
}

type ConstraintEntry = { check?: Record<string, unknown>; unique?: Record<string, unknown> }

async function constraintsOf(dir: string): Promise<Record<string, ConstraintEntry>> {
	const module = (await import(path.join(dir, "src/db/db.core.constraints.gen.ts"))) as Record<string, unknown>
	return module["CORE_DB_CONSTRAINT_MAP"] as Record<string, ConstraintEntry>
}

const accepts = (schema: z.ZodObject | undefined, value: unknown) => (schema as z.ZodObject).safeParse(value).success
const keys = (schema: z.ZodObject | undefined) => Object.keys(schema?.shape ?? {}).sort()
const entities = (dir: string) => fs.readdirSync(path.join(dir, "src/db/dtos")).sort()

describe("a column no comb rule names (F6)", () => {
	it("types a column of c imported under another name", async () => {
		const dir = await generated(
			`import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c as col } from "@lovrozagar/comb/sqlite/columns"
export const item = sqliteTable("item", { id: col.id("itm"), name: col.text("name", { max: 3 }) })`,
			{ head: false },
		)
		const { itemDtoCreateSchema: create } = await dtosOf(dir, "item")
		expect(accepts(create, { name: "abc" })).toBe(true)
		expect(accepts(create, { name: "abcd" })).toBe(false)
		expect(accepts(create, { name: 7 })).toBe(false)
	}, 120_000)

	it("types plain drizzle columns from their config: text, varchar's length, uuid's default, a pgEnum", async () => {
		const dir = await generated(
			`import { pgEnum, text, uuid, varchar } from "drizzle-orm/pg-core"
export const mood = pgEnum("mood", ["ok", "sad"])
export const item = pgTable("item", { id: uuid("id").defaultRandom().primaryKey(), code: varchar("code", { length: 3 }), note: text("note"), feeling: mood("feeling") })`,
			{ dialect: "postgres" },
		)
		const { itemDtoCreateSchema: create } = await dtosOf(dir, "item")
		expect(accepts(create, { code: "abc", feeling: "ok", note: "n" })).toBe(true)
		expect(accepts(create, { code: "12345" })).toBe(false)
		expect(accepts(create, { note: {} })).toBe(false)
		expect(accepts(create, { feeling: "furious" })).toBe(false)
	}, 120_000)
})

describe("a composite primary key (F7)", () => {
	it("requires each key column on create and leaves it out of update", async () => {
		const dir = await generated(`import { primaryKey } from "drizzle-orm/sqlite-core"
export const membership = sqliteTable("membership", { orgSlug: c.text("org_slug"), userSlug: c.text("user_slug"), role: c.text("role").notNull() }, (t) => [primaryKey({ columns: [t.orgSlug, t.userSlug] })])`)
		const dtos = await dtosOf(dir, "membership")
		expect(accepts(dtos["membershipDtoCreateSchema"], { role: "admin" })).toBe(false)
		expect(accepts(dtos["membershipDtoCreateSchema"], { orgSlug: "o", role: "admin", userSlug: "u" })).toBe(true)
		expect(keys(dtos["membershipDtoUpdateSchema"])).toEqual(["role"])
	}, 120_000)
})

describe("columns the database fills (F8)", () => {
	it("leaves an identity key and a generated column out of the write bodies", async () => {
		const dir = await generated(
			`import { sql } from "drizzle-orm"
export const item = pgTable("item", { id: c.integer("id").primaryKey().generatedAlwaysAsIdentity(), title: c.text("title").notNull(), total: c.integer("total").generatedAlwaysAs(sql\`1 + 1\`) })`,
			{ dialect: "postgres" },
		)
		const dtos = await dtosOf(dir, "item")
		expect(keys(dtos["itemDtoCreateSchema"])).toEqual(["title"])
		expect(keys(dtos["itemDtoUpdateSchema"])).toEqual(["title"])
	}, 120_000)
})

describe("constraints drizzle names or that sit in a block (F12, F13, F14)", () => {
	it("maps an unnamed unique() under drizzle's name for it (F12)", async () => {
		const dir = await generated(`import { unique } from "drizzle-orm/sqlite-core"
export const seat = sqliteTable("seat", { id: c.id("set"), userId: c.text("user_id").notNull() }, (t) => [unique().on(t.userId)])
export const slot = sqliteTable("slot", { id: c.id("slt"), day: c.integer("day"), hour: c.integer("hour") }, (t) => [unique().on(t.day, t.hour)])`)
		const map = await constraintsOf(dir)
		expect(Object.keys(map["seat"]?.unique ?? {})).toContain("user_id")
		expect(Object.keys(map["slot"]?.unique ?? {})).toContain("day,hour")
	}, 120_000)

	it("reads a third argument written as a block (F13)", async () => {
		const dir = await generated(`import { sql } from "drizzle-orm"
import { check, uniqueIndex } from "drizzle-orm/sqlite-core"
export const booking = sqliteTable("booking", { id: c.id("bkg"), code: c.text("code").notNull(), seats: c.integer("seats").notNull() }, (t) => {
	return [check("booking_seats_positive", sql\`\${t.seats} > 0\`), uniqueIndex("booking_code_uq").on(t.code)]
})`)
		const map = await constraintsOf(dir)
		expect(JSON.stringify(map["booking"])).toContain("booking_seats_positive")
		expect(Object.keys(map["booking"]?.unique ?? {})).toContain("code")
	}, 120_000)

	it("maps a unique index on an expression under its name (F14)", async () => {
		const dir = await generated(`import { sql } from "drizzle-orm"
import { uniqueIndex } from "drizzle-orm/sqlite-core"
export const user = sqliteTable("user", { id: c.id("usr"), email: c.text("email").notNull() }, (t) => [uniqueIndex("user_email_lower_uq").on(sql\`lower(\${t.email})\`)])`)
		const map = await constraintsOf(dir)
		expect(Object.keys(map["user"]?.unique ?? {})).toContain("user_email_lower_uq")
	}, 120_000)
})

describe("every table the module exports (F16, F17, F18)", () => {
	it("reads two tables of one statement, and a table whose columns are a const (F16)", async () => {
		const dir = await generated(`const noteColumns = { id: c.id("not"), body: c.text("body") }
export const tag = sqliteTable("tag", { id: c.id("tag") }), label = sqliteTable("label", { id: c.id("lbl") })
export const note = sqliteTable("note", noteColumns)`)
		expect(entities(dir)).toEqual(["_shared", "label", "note", "tag"])
	}, 120_000)

	it("reads a table re-exported through a local binding (F17)", async () => {
		const dir = await generated(
			`import { invoice } from "./billing.ts"
export { invoice }
export const user = sqliteTable("user", { id: c.id("usr") })`,
			{
				files: {
					"src/db/billing.ts": `${HEAD.sqlite}export const invoice = sqliteTable("invoice", { id: c.id("inv") })\n`,
				},
			},
		)
		expect(entities(dir)).toEqual(["_shared", "invoice", "user"])
	}, 120_000)

	it("reads a pgSchema's table and pgTable.withRLS (F18)", async () => {
		const dir = await generated(
			`import { pgSchema } from "drizzle-orm/pg-core"
export const auth = pgSchema("auth")
export const account = auth.table("account", { id: c.id("acc") })
export const note = pgTable.withRLS("note", { id: c.id("not"), accountId: c.ref("account_id").references(() => account.id) })`,
			{ dialect: "postgres" },
		)
		expect(entities(dir)).toEqual(["_shared", "account", "note"])
	}, 120_000)
})

describe("a key into a table under another name (F24)", () => {
	it("follows an import alias and a namespace to the table", async () => {
		const dir = await generated(
			`import { user as account } from "./users.ts"
import * as schema from "./users.ts"
export { user } from "./users.ts"
export const post = sqliteTable("post", { id: c.id("pst"), ownerId: c.ref("owner_id").references(() => account.id), editorId: c.ref("editor_id").references(() => schema.user.id) })`,
			{
				files: { "src/db/users.ts": `${HEAD.sqlite}export const user = sqliteTable("user", { id: c.id("usr") })\n` },
			},
		)
		const json = JSON.parse(read(dir, "src/db/diagrams/core-relations.gen.json")) as {
			relations: Array<{ to: string }>
		}
		expect(json.relations.map((relation) => relation.to)).toEqual(["user.id", "user.id"])
	}, 120_000)
})

describe("a module only types use (the 4.2 review's F42a)", () => {
	it("is loaded by neither the tables module nor codegen's walk, however the import is written", async () => {
		const dir = await generated(
			`import { type Bad } from "./bad.ts"
import { Bad as Also } from "./bad.ts"
let unused: Bad | Also | undefined
export const note = sqliteTable("note", { id: c.id("not") })`,
			{ files: { "src/db/bad.ts": `export type Bad = string\nthrow new Error("bad loaded")\n` } },
		)
		expect(entities(dir)).toEqual(["_shared", "note"])
	}, 120_000)
})
