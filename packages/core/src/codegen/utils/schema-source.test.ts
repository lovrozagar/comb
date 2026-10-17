import { SyntaxKind } from "ts-morph"
import { describe, expect, it } from "vitest"
import { importRefs, readJsonSchema } from "./schema-source.ts"
import { createProject } from "./ts-morph.ts"

function setup(source: string, files: Record<string, string> = {}) {
	const project = createProject()
	for (const [name, text] of Object.entries(files)) project.createSourceFile(`/app/${name}`, text)
	const file = project.createSourceFile("/app/db.x.tables.ts", source)
	const column = (name: string) => {
		const found = file
			.getDescendantsOfKind(SyntaxKind.PropertyAssignment)
			.find((p) => p.getName() === name)
			?.getInitializer()
		if (found === undefined) throw new Error(`no column ${name}`)
		return found
	}
	return { column, file }
}

describe("readJsonSchema", () => {
	it("reads the schema argument of c.json as an expression and the names it uses", () => {
		const { column } = setup(`export const t = sqliteTable("t", {
	a: c.json("a", settingsSchema),
	b: c.json<Record<string, X>>('b', schemas.settings, { maxBytes: 10 }),
	c: c.json("c", z.object({ digest: z.boolean(), nested: inner })).notNull(),
	d: c.text("d"),
	e: c.json("e"),
})`)
		expect(readJsonSchema(column("a"))).toEqual({ expression: "settingsSchema", names: ["settingsSchema"] })
		expect(readJsonSchema(column("b"))).toEqual({ expression: "schemas.settings", names: ["schemas"] })
		expect(readJsonSchema(column("c"))).toEqual({
			expression: "z.object({ digest: z.boolean(), nested: inner })",
			names: ["inner"],
		})
		expect(readJsonSchema(column("d"))).toBeNull()
		expect(readJsonSchema(column("e"))).toBeNull()
	})
})

describe("importRefs", () => {
	it("finds where each name comes from: a project file, a package, or the tables file itself", () => {
		const { file } = setup(
			`import { settingsSchema } from "./schemas"
import { ROLES as roles } from "@app/shared"
import * as schemas from "./all-schemas"
export const localSchema = z.object({})
const hidden = z.object({})
export const t = sqliteTable("t", {})`,
			{ "schemas.ts": "export const settingsSchema = 1", "all-schemas.ts": "export const s = 1" },
		)
		expect(importRefs(["settingsSchema", "roles", "schemas", "localSchema"], file)).toEqual([
			{ from: "./schemas", imported: "settingsSchema", name: "settingsSchema", path: "/app/schemas.ts" },
			{ from: "@app/shared", imported: "ROLES", name: "roles", path: null },
			{ from: "./all-schemas", imported: "*", name: "schemas", path: "/app/all-schemas.ts" },
			{ from: "./db.x.tables", imported: "localSchema", name: "localSchema", path: "/app/db.x.tables.ts" },
		])
		expect(() => importRefs(["hidden"], file)).toThrow(
			'"hidden" is declared in /app/db.x.tables.ts without export, so the generated DTOs cannot import it',
		)
		expect(importRefs(["Date"], file)).toEqual([])
	})

	it("resolves a relative import whose file the project does not hold to no path", () => {
		const { file } = setup(`import { a } from "./missing"\nexport const t = 1`)
		expect(importRefs(["a"], file)).toEqual([{ from: "./missing", imported: "a", name: "a", path: null }])
	})
})

describe("importRefs: other declaration forms", () => {
	it("reads default imports and exported functions and classes, and refuses unexported ones", () => {
		const { file } = setup(`import shared from "@app/shared"
export function makeSchema() { return 1 }
export class Registry {}
function hiddenFn() { return 1 }
export const t = 1`)
		expect(importRefs(["shared", "makeSchema", "Registry"], file).map((r) => [r.name, r.imported, r.from])).toEqual([
			["shared", "default", "@app/shared"],
			["makeSchema", "makeSchema", "./db.x.tables"],
			["Registry", "Registry", "./db.x.tables"],
		])
		expect(() => importRefs(["hiddenFn"], file)).toThrow("without export")
	})
})
