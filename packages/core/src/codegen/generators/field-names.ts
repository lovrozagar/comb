/**
 * Field name generator — produces human-readable field name records
 * from database table metadata for i18n field translation.
 *
 * Collects unique field names across all tables, converts snake_case
 * to labels, and strips common suffixes (_json, _id).
 */
import fs from "node:fs"
import path from "node:path"
import type { TableMeta } from "../analyzer-types.ts"
import { toScreamingSnakeCase } from "../utils/case.ts"
import { writeGenFile, writeJsonAtomic } from "../utils/fs.ts"

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
	/* capitalize first word, lowercase rest */
	const words = cleaned.split("_")
	const first = words[0]
	if (first === undefined) return name
	return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ")
}

function generateFieldNames(tables: TableMeta[], dbName: string, config: FieldNamesConfig, cwd: string): void {
	const outputPath = path.resolve(cwd, config.output)

	/* collect unique non-private field names */
	const fieldSet = new Set<string>()
	for (const table of tables) {
		for (const field of table.fields) {
			if (field.name.startsWith("_")) continue
			fieldSet.add(field.name)
		}
	}

	if (fieldSet.size === 0) {
		console.log("  field-names: no fields found — skipped")
		return
	}

	/* build sorted record: raw name -> label */
	const entries: Array<[string, string]> = []
	for (const name of Array.from(fieldSet).sort()) {
		entries.push([name, fieldToLabel(name)])
	}

	const constName = `${toScreamingSnakeCase(dbName)}_DB_FIELD_NAMES`
	const typeName = `${dbName.charAt(0).toUpperCase() + dbName.slice(1)}DbFieldName`

	const lines: string[] = []
	lines.push(`const ${constName} = {`)

	for (const [rawName, label] of entries) {
		/* add comment when label differs from raw due to suffix stripping */
		const stripped = rawName !== label.toLowerCase().replaceAll(" ", "_")
		if (stripped) {
			lines.push(`\t${rawName}: "${label}", /* was ${rawName} */`)
		} else {
			lines.push(`\t${rawName}: "${label}",`)
		}
	}

	lines.push("} as const")
	lines.push("")
	lines.push(`type ${typeName} = keyof typeof ${constName}`)
	lines.push("")
	lines.push(`export { ${constName}, type ${typeName} }`)
	lines.push("")

	writeGenFile(outputPath, lines.join("\n"), "comb")

	if (config.updatePackageJson) {
		const packageJsonPath = findNearestPackageJson(path.dirname(outputPath))
		if (packageJsonPath) {
			updatePackageJson(packageJsonPath, outputPath)
		}
	}

	console.log(`  field-names: ${outputPath} (${entries.length} fields)`)
}

/** Walk up from dir to find nearest package.json */
function findNearestPackageJson(dir: string): string | null {
	let current = dir
	while (current !== path.dirname(current)) {
		const candidate = path.join(current, "package.json")
		if (fs.existsSync(candidate)) return candidate
		current = path.dirname(current)
	}
	return null
}

function updatePackageJson(packageJsonPath: string, outputPath: string): void {
	const content = fs.readFileSync(packageJsonPath, "utf-8")
	const pkg = JSON.parse(content) as Record<string, unknown>

	const packageDir = path.dirname(packageJsonPath)
	const relativePath = `./${path.relative(packageDir, outputPath)}`

	const existingExports = (pkg["exports"] ?? {}) as Record<string, string>
	const newExports: Record<string, string> = {}

	for (const [key, value] of Object.entries(existingExports)) {
		if (key !== "./field-names") {
			newExports[key] = value as string
		}
	}

	newExports["./field-names"] = relativePath

	pkg["exports"] = newExports
	writeJsonAtomic(packageJsonPath, pkg)
}

export { generateFieldNames }
