/**
 * The local names an entity file imports its c.json schemas under (F1, F2 of the 0.14.1 review). A
 * schema is its module's export, so two modules' `profile` are two imports: an export name more than
 * one module gives, or one a generated file declares itself, is imported under an alias that names
 * its module, `profileFromWorkSchemas`, numbered on if that is taken too. Which names keep their own
 * never turns on the order the tables are read in.
 */
import type { AnalysisResult, ImportRef } from "../../analyzer-types.ts"
import { byCodeUnit } from "../../utils/order.ts"
import { snakeToCamel, snakeToPascal } from "../../utils/case.ts"
import { SUFFIX } from "./entity-file.ts"

/* the names a generated entity or shared file declares or imports itself, whatever the tables */
const GENERATED = /^(?:z|combMeta|timestampSchema|cidrSchema|_.*|timestamps.*)$/

/** A schema import's identity: its module and its export */
const keyOf = (ref: ImportRef): string => `${ref.path ?? ref.from}\u0000${ref.imported}`

/** A module's last two path parts as one Pascal word: `/app/work/schemas.ts` is `WorkSchemas` */
function moduleWord(ref: ImportRef): string {
	const parts = (ref.path ?? ref.from).replace(/\.[cm]?[jt]sx?$/, "").split(/[\\/]/)
	return parts
		.slice(-2)
		.flatMap((part) => part.split(/[^A-Za-z0-9]+/))
		.filter((word) => word !== "")
		.map((word) => (word[0] as string).toUpperCase() + word.slice(1))
		.join("")
}

/** The analysis with each c.json schema import under a local name of its own in every file it is imported into */
function aliasSchemaImports(analysis: AnalysisResult): AnalysisResult {
	const refs = new Map(
		analysis.tables
			.flatMap((table) => table.fields.flatMap((field) => field.schemaImports))
			.map((ref) => [keyOf(ref), ref]),
	)
	const keys = [...refs.keys()].sort(byCodeUnit)
	const modules = new Map<string, number>()
	for (const ref of refs.values()) modules.set(ref.imported, (modules.get(ref.imported) ?? 0) + 1)
	const tableNames = new Set(
		analysis.tables.flatMap((table) =>
			Object.values(SUFFIX).flatMap((suffix) => [
				`${snakeToCamel(table.varName)}${suffix}Schema`,
				`${snakeToPascal(table.varName)}${suffix}`,
			]),
		),
	)
	const own = (imported: string) =>
		!GENERATED.test(imported) && !tableNames.has(imported) && modules.get(imported) === 1
	const names = new Map<string, string>()
	const taken = new Set(tableNames)
	for (const key of keys) {
		const { imported } = refs.get(key) as ImportRef
		if (own(imported)) names.set(key, imported)
		if (own(imported)) taken.add(imported)
	}
	for (const key of keys.filter((each) => !names.has(each))) {
		const ref = refs.get(key) as ImportRef
		const base = `${ref.imported.replace(/^_+/, "") || "schema"}From${moduleWord(ref)}`
		let name = base
		for (let n = 2; taken.has(name) || GENERATED.test(name); n++) name = `${base}${n}`
		names.set(key, name)
		taken.add(name)
	}
	const named = (ref: ImportRef) => ({ ...ref, name: names.get(keyOf(ref)) as string })
	const tables = analysis.tables.map((table) => ({
		...table,
		fields: table.fields.map((field) => {
			const [ref] = field.schemaImports
			if (ref === undefined) return field
			return {
				...field,
				jsonSchemaName: names.get(keyOf(ref)) as string,
				schemaImports: field.schemaImports.map(named),
			}
		}),
	}))
	return { ...analysis, imports: { ...analysis.imports, jsonSchemaImports: new Set(names.values()) }, tables }
}

export { aliasSchemaImports }
