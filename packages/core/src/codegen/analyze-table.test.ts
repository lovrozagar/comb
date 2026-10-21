import { describe, expect, it } from "vitest"
import { parseTable } from "./analyze-table.ts"
import type { ImportsMeta } from "./analyzer-types.ts"
import { createProject } from "./utils/ts-morph.ts"

function tableOf(source: string, imports: ImportsMeta = emptyImports()) {
	const file = createProject().createSourceFile("db.x.tables.ts", source)
	const declaration = file.getVariableStatements().at(-1)?.getDeclarations()[0]
	if (declaration === undefined) throw new Error("no declaration")
	return { imports, table: parseTable(declaration, imports) }
}

function emptyImports(): ImportsMeta {
	return { enumImports: new Map(), identifierValues: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() }
}

describe("parseTable", () => {
	it("reads the SQL name, fields, id prefix and timestamps", () => {
		const { table } = tableOf(`export const post = sqliteTable("posts", {
	id: c.id("pst"),
	created_at: c.createdAt("created_at"),
	updatedAt: c.updatedAt("updatedAt"),
	deleted_at: c.deletedAt("deleted_at"),
})`)
		expect(table).toMatchObject({
			hasCompositePrimaryKey: false,
			idPrefix: "pst",
			sqlName: "posts",
			timestamps: {
				createdAt: true,
				deletedAt: true,
				names: { createdAt: "created_at", deletedAt: "deleted_at", updatedAt: "updatedAt" },
				style: "mixed",
				updatedAt: true,
			},

			varName: "post",
		})
		expect(table?.fields.map((f) => f.name)).toEqual(["id", "created_at", "updatedAt", "deleted_at"])
	})
})

describe("parseTable: options", () => {
	it("reads composite keys, unique indexes and CHECKs from the options", () => {
		const { table } = tableOf(`export const m = sqliteTable("m", { a: c.text("a"), b: c.text("b") }, (x) => [
	primaryKey({ columns: [x.a, x.b] }),
	uniqueIndex("m_a_idx").on(x.a, x.b),
	check("m_a_check", sql\`length(a) > 0\`),
])`)
		expect(table).toMatchObject({
			checkConstraints: [{ expression: "length(a) > 0", name: "m_a_check" }],
			hasCompositePrimaryKey: true,
			idPrefix: null,
			timestamps: {
				createdAt: false,
				deletedAt: false,
				names: { createdAt: null, deletedAt: null, updatedAt: null },
				style: "camelCase",
				updatedAt: false,
			},
			uniqueIndexes: [{ columns: ["a", "b"], name: "m_a_idx" }],
		})
	})

	it("records the enum and JSON schema identifiers its fields use", () => {
		const result = tableOf(`import { roles } from "@app/enums"
import { prefsSchema } from "./schemas"
export const u = sqliteTable("u", { role: c.enum("role", roles), prefs: c.json("prefs", prefsSchema.optional()) })`)
		expect([...result.imports.enumImports]).toEqual([["roles", "@app/enums"]])
		expect([...result.imports.jsonSchemaImports]).toEqual(["prefsSchema"])
		const [role, prefs] = result.table?.fields ?? []
		expect(role).toMatchObject({
			enumName: "roles",
			enumValues: null,
			schemaImports: [{ from: "@app/enums", name: "roles" }],
		})
		expect(prefs).toMatchObject({
			jsonSchemaName: "prefsSchema.optional()",
			schemaImports: [{ from: "./schemas", name: "prefsSchema" }],
		})
	})

	it("is null when the call carries no column object", () => {
		expect(tableOf('export const t = sqliteTable("t")').table).toBeNull()
		expect(tableOf('export const t = sqliteTable("t", columns)').table).toBeNull()
		expect(tableOf("export const t = 1").table).toBeNull()
	})
})

describe("parseTable: timestamps (M-M8)", () => {
	it("counts a timestamp column only when it holds epoch milliseconds, not by its name alone", () => {
		const { table } = tableOf(`export const e = sqliteTable("e", {
	id: c.id("evt"),
	created_at: c.text("created_at").notNull(),
	updated_at: c.integer("updated_at").notNull(),
	deleted_at: c.json("deleted_at", s),
})`)
		expect(table?.timestamps).toEqual({
			createdAt: false,
			deletedAt: false,
			names: { createdAt: null, deletedAt: null, updatedAt: "updated_at" },
			style: "snake_case",
			updatedAt: true,
		})
	})
})

describe("parseTable: definitions the raw text misread (M-M7)", () => {
	it("ignores what a comment inside a column chain says", () => {
		const { table } = tableOf(`export const t = sqliteTable("t", {
	id: c.id("ttt"),
	title: c.text("title") // TODO: .notNull()
		.default("x"),
	body: c.text("body") /* .primaryKey() */,
})`)
		expect(table?.fields.map((f) => [f.name, f.isNotNull, f.isPrimaryKey])).toEqual([
			["id", true, true],
			["title", false, false],
			["body", false, false],
		])
	})

	it("reads the columns a spread of a shared const adds", () => {
		const { table } = tableOf(`const timestamps = {
	created_at: c.createdAt("created_at"),
	deleted_at: c.deletedAt("deleted_at"),
}
export const t = sqliteTable("t", { id: c.id("ttt"), ...timestamps, title: c.text("title") })`)
		expect(table?.fields.map((f) => f.name)).toEqual(["id", "created_at", "deleted_at", "title"])
		expect(table?.timestamps).toMatchObject({ createdAt: true, deletedAt: true })
	})

	it("names a quoted key by its value, not its quotes", () => {
		const { table } = tableOf(
			`export const t = sqliteTable("t", { id: c.id("ttt"), "display-name": c.text("display_name") })`,
		)
		expect(table?.fields.map((f) => f.name)).toEqual(["id", "display-name"])
	})

	it("publishes only plain column uniqueness, not expression or partial unique indexes", () => {
		const { table } =
			tableOf(`export const t = sqliteTable("t", { id: c.id("ttt"), email: c.text("email"), slug: c.text("slug"), org: c.text("org") }, (t) => [
	uniqueIndex("t_email_lower").on(sql\`lower(\${t.email})\`),
	uniqueIndex("t_slug_live").on(t.slug).where(sql\`deleted_at is null\`),
	uniqueIndex("t_org_slug").on(t.org, t.slug),
])`)
		expect(table?.uniqueIndexes).toEqual([{ columns: ["org", "slug"], name: "t_org_slug" }])
	})
})

describe("parseTable: SQL names written as consts or quoted (F7)", () => {
	it("reads a table and a column name from the const that holds it, and a quote inside a name as itself", () => {
		const { table } = tableOf(`const ORDERS = "orders"
const OWNER = "owner_id"
export const order = sqliteTable(ORDERS, { id: c.id("ord"), ownerId: c.ref(OWNER).notNull() })`)
		expect(table?.sqlName).toBe("orders")
		expect(table?.fields.find((f) => f.name === "ownerId")?.sqlName).toBe("owner_id")
		expect(tableOf(`export const quoted = sqliteTable('quo"ted', { id: c.id("qt") })`).table?.sqlName).toBe('quo"ted')
	})

	it("fails on a table or column name it cannot read, naming where", () => {
		expect(() => tableOf(`export const t = sqliteTable(nameOf(), { id: c.id("ttt") })`)).toThrow(
			/:1: comb cannot read the SQL name nameOf\(\)/,
		)
		expect(() => tableOf(`export const t = sqliteTable("t", { id: c.id("ttt"), n: c.text(nameOf()) })`)).toThrow(
			/:1: comb cannot read the SQL name nameOf\(\)/,
		)
	})
})

describe("parseTable: a column given by a const", () => {
	it("reads its SQL name from the text when its value is no column call", () => {
		const { table } = tableOf(
			`const note = c.text("note_text")
export const t = sqliteTable("t", { id: c.id("ttt"), note })`.replace("note })", "note: note })"),
		)
		expect(table?.fields.find((f) => f.name === "note")?.sqlName).toBe("note")
	})
})
