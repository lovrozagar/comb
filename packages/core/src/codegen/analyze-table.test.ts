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
	...shared,
})`)
		expect(table).toMatchObject({
			hasCompositePrimaryKey: false,
			idPrefix: "pst",
			sqlName: "posts",
			timestamps: { createdAt: true, deletedAt: true, style: "snake_case", updatedAt: true },
			varName: "post",
		})
		expect(table?.fields.map((f) => f.name)).toEqual(["id", "created_at", "updatedAt", "deleted_at"])
	})

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
			timestamps: { createdAt: false, deletedAt: false, style: "camelCase", updatedAt: false },
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
		expect(table?.timestamps).toEqual({ createdAt: false, deletedAt: false, style: "snake_case", updatedAt: true })
	})
})
