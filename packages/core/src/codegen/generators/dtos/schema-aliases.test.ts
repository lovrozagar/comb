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
		const result = aliasSchemaImports(analysis([["user", [profile, profile]]]), "/app")
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
			"/app",
		)
		const backward = aliasSchemaImports(
			analysis([
				["b", [work]],
				["a", [home]],
			]),
			"/app",
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
		expect(namesOf(aliasSchemaImports(analysis([["user", refs]]), "/"))[0]?.map(([name]) => name)).toEqual([
			"zFromAppSchemas2",
			"combMetaFromAppSchemas",
			"schemaFromAppSchemas",
			"userDtoReadSchemaFromAppSchemas",
			"zFromAppSchemas",
			"strFromAcmeShapes",
		])
	})
})

/* the reviewer's reading of F1: generated output is byte-identical wherever the project is checked out */
/** One table importing a root module's `profile` and a lib module's, under `root` */
const layout = (root: string): Array<[string, ImportRef[]]> => [
	["user", [project(`${root}/schemas.ts`, "profile"), project(`${root}/lib/schemas.ts`, "profile")]],
]

/** The names the layout's imports take under `root` */
const names = (root: string) => namesOf(aliasSchemaImports(analysis(layout(root)), root))

describe("aliasSchemaImports from two checkouts", () => {
	it("names one layout's imports alike under two project roots", () => {
		expect(names("/home/dev/app")).toEqual(names("/tmp/ci-zz"))
		expect(names("/home/dev/app")[0]?.map(([name]) => name)).toEqual(["profileFromSchemas", "profileFromLibSchemas"])
	})
})
