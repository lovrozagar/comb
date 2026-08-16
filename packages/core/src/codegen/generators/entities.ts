/**
 * Entities generator — produces typed entity ID generation from table prefixes.
 *
 * Tables using c.id("prefix") get included in the prefix map.
 * Tables using c.serialId() are skipped (no entity prefix).
 */
import fs from "node:fs"
import path from "node:path"
import type { TableMeta } from "../analyzer-types.ts"
import { writeGenFile, writeJsonAtomic } from "../utils/fs.ts"

type EntitiesConfig = {
	importFrom?: string | undefined
	output: string
	updatePackageJson?: boolean
}

function generateEntities(tables: TableMeta[], dbName: string, config: EntitiesConfig, cwd: string): void {
	const outputPath = path.resolve(cwd, config.output)

	const prefixedTables = tables.filter((t) => t.idPrefix !== null)

	if (prefixedTables.length === 0) {
		console.log("  entities: no tables with c.id(prefix) — skipped")
		return
	}

	const lines: string[] = []

	const importFrom = config.importFrom ?? "@lovrozagar/comb"
	lines.push(`import { generateId, generateUlid } from "${importFrom}"`)
	lines.push("")

	lines.push("const entityPrefixes = {")
	for (const t of prefixedTables) {
		lines.push(`\t${t.varName}: "${t.idPrefix}",`)
	}
	lines.push("} as const")
	lines.push("")

	lines.push("type EntityName = keyof typeof entityPrefixes")
	lines.push("")

	lines.push("function generateEntityId<T extends EntityName>(entity: T): string {")
	lines.push("\treturn generateId(entityPrefixes[entity])")
	lines.push("}")
	lines.push("")

	lines.push("export { entityPrefixes, generateEntityId, generateUlid, type EntityName }")
	lines.push("")

	writeGenFile(outputPath, lines.join("\n"), "comb")

	if (config.updatePackageJson) {
		const packageJsonPath = findNearestPackageJson(path.dirname(outputPath))
		if (packageJsonPath) {
			updatePackageJson(packageJsonPath, outputPath)
		}
	}

	console.log(`  entities: ${outputPath} (${prefixedTables.length} entities)`)
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
		if (key !== "./entities") {
			newExports[key] = value as string
		}
	}

	newExports["./entities"] = relativePath

	pkg["exports"] = newExports
	writeJsonAtomic(packageJsonPath, pkg)
}

export { generateEntities }
