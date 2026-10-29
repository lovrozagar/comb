import { describe, expect, it } from "vitest"
import type { AnalysisResult, ImportRef } from "../../analyzer-types.ts"
import { aliasSchemaImports } from "./schema-aliases.ts"

/** A project module's export, as importOf records it */
const project = (file: string, imported: string): ImportRef => ({
	from: `./${file.split("/").at(-1)?.replace(/\.ts$/, "")}`,
	imported,
	name: imported,
	path: file,
})

/** An analysis of tables named `tables`, each holding a c.json column per ref, in order */
function analysis(tables: Array<[string, ImportRef[]]>): AnalysisResult {
	return {
		dbName: "test",
		dialect: "sqlite",
		imports: { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() },
		tables: tables.map(([varName, refs]) => ({
			fields: refs.map((ref, i) => ({ jsonSchemaName: ref.name, name: `f${i}`, schemaImports: [ref] })),
			varName,
		})),
		tablesImportPath: "./db.tables",
	} as unknown as AnalysisResult
}

/** The local name each field of each table imports its schema under */
const namesOf = (result: AnalysisResult) =>
	result.tables.map((table) =>
		table.fields.map((field) => [field.jsonSchemaName, field.schemaImports[0]?.name, field.schemaImports[0]?.imported]),
	)

/* F1, F2 of the 0.14.1 review */
describe("aliasSchemaImports", () => {
	it("keeps a name one module gives and nothing generated declares, and imports it once however many columns use it", () => {
		const profile = project("/app/schemas.ts", "profile")
		const result = aliasSchemaImports(analysis([["user", [profile, profile]]]))
		expect(namesOf(result)).toEqual([
			[
				["profile", "profile", "profile"],
				["profile", "profile", "profile"],
			],
		])
		expect(result.imports.jsonSchemaImports).toEqual(new Set(["profile"]))
	})

	it("names a module's export apart from another module's of the same name, whatever order the tables come in", () => {
		const [home, work] = [project("/app/home/schemas.ts", "profile"), project("/app/work/schemas.ts", "profile")]
		const forward = aliasSchemaImports(
			analysis([
				["a", [home]],
				["b", [work]],
			]),
		)
		const backward = aliasSchemaImports(
			analysis([
				["b", [work]],
				["a", [home]],
			]),
		)
		expect(namesOf(forward)).toEqual([
			[["profileFromHomeSchemas", "profileFromHomeSchemas", "profile"]],
			[["profileFromWorkSchemas", "profileFromWorkSchemas", "profile"]],
		])
		expect(namesOf(backward).toReversed()).toEqual(namesOf(forward))
	})

	it("aliases a name a generated file declares, and numbers on an alias that is taken too", () => {
		const refs = [
			project("/app/schemas.ts", "z"),
			project("/app/schemas.ts", "combMeta"),
			project("/app/schemas.ts", "__"),
			project("/app/schemas.ts", "userDtoReadSchema"),
			project("/app/x/schemas.ts", "zFromAppSchemas"),
			{ from: "@acme/shapes", imported: "_str", name: "_str", path: null },
		]
		expect(namesOf(aliasSchemaImports(analysis([["user", refs]])))[0]?.map(([name]) => name)).toEqual([
			"zFromAppSchemas2",
			"combMetaFromAppSchemas",
			"schemaFromAppSchemas",
			"userDtoReadSchemaFromAppSchemas",
			"zFromAppSchemas",
			"strFromAcmeShapes",
		])
	})
})
