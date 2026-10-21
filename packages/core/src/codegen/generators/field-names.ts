/**
 * Field name generator — produces human-readable field name records
 * from database table metadata for i18n field translation.
 *
 * Collects unique field names across all tables, converts snake_case
 * to labels, and strips common suffixes (_json, _id).
 */
import path from "node:path"
import { commentText, dbIdentifiers, propertyName } from "../utils/case.ts"
import { writeGenFile } from "../utils/fs.ts"
import { findNearestPackageJson, setPackageExport } from "../utils/package-json.ts"
import type { GeneratorContext } from "./context-types.ts"

type FieldNamesConfig = {
	output: string
	updatePackageJson?: boolean
}

/** Convert snake_case field name to human label */
function fieldToLabel(name: string): string {
	/* strip _json suffix */
	let cleaned = name.endsWith("_json") ? name.slice(0, -5) : name
	/* strip _id suffix (but keep bare "id") */
	if (cleaned.endsWith("_id") && cleaned !== "id") {
		cleaned = cleaned.slice(0, -3)
	}
	/* capitalize the first word, keep the rest, separate words with spaces */
	return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).replaceAll("_", " ")
}

function generateFieldNames(ctx: GeneratorContext, config: FieldNamesConfig): void {
	const { dbName, tables } = ctx.analysis
	const { cwd } = ctx
	const outputPath = path.resolve(cwd, config.output)

	/* collect unique non-private field names */
	const fieldSet = new Set<string>()
	for (const table of tables) {
		for (const field of table.fields) {
			/* the analyzer marks `_`-prefixed names private too */
			if (field.constraints.private) continue
			fieldSet.add(field.name)
		}
	}

	if (fieldSet.size === 0) {
		ctx.log("  field-names: no fields found — skipped")
		return
	}

	/* build sorted record: raw name -> label */
	const entries: Array<[string, string]> = []
	for (const name of Array.from(fieldSet).sort()) {
		entries.push([name, fieldToLabel(name)])
	}

	const { constant, pascal } = dbIdentifiers(dbName)
	const constName = `${constant}_DB_FIELD_NAMES`
	const typeName = `${pascal}DbFieldName`

	const lines: string[] = []
	lines.push(`const ${constName} = {`)

	for (const [rawName, label] of entries) {
		/* add comment when label differs from raw due to suffix stripping */
		const stripped = rawName !== label.toLowerCase().replaceAll(" ", "_")
		if (stripped) {
			lines.push(`\t${propertyName(rawName)}: ${JSON.stringify(label)}, /* was ${commentText(rawName)} */`)
		} else {
			lines.push(`\t${propertyName(rawName)}: ${JSON.stringify(label)},`)
		}
	}

	lines.push("} as const")
	lines.push("")
	lines.push(`type ${typeName} = keyof typeof ${constName}`)
	lines.push("")
	lines.push(`export { ${constName}, type ${typeName} }`)
	lines.push("")

	writeGenFile(outputPath, lines.join("\n"), { generator: "comb", staged: ctx.staged })

	if (config.updatePackageJson) exportFieldNames(ctx, outputPath)

	ctx.log(`  field-names: ${outputPath} (${entries.length} fields)`)
}

/** The package.json nearest the field-names file exports it as ./field-names */
function exportFieldNames(ctx: GeneratorContext, outputPath: string): void {
	const packageJsonPath = findNearestPackageJson(path.dirname(outputPath), ctx.cwd)
	if (!packageJsonPath) return
	const subpath = { namespace: ctx.exportNamespace, staged: ctx.staged, subpath: "./field-names" }
	setPackageExport(packageJsonPath, subpath, outputPath)
}

/** Walk up from dir to find nearest package.json */
export { generateFieldNames }
