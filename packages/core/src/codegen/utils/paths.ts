/** The names generated files derive from paths: a database's from its tables file, and import specifiers */
import path from "node:path"

/**
 * Extract database name from tables file path.
 * Handles both legacy (db.core.tables.ts) and saas ({name}.db.{dbName}.tables.gen.ts) patterns.
 */
export function extractDbName(filePath: string): string {
	const fileName = path.basename(filePath)
	/* prefixed pattern: anyrow.db-core.tables.ts -> core */
	const prefixedMatch = fileName.match(/\.db-(\w+)\.tables/)
	if (prefixedMatch?.[1] !== undefined) return prefixedMatch[1]
	/* saas pattern: test.db.core.tables.gen.ts -> core */
	const saasMatch = fileName.match(/\.db\.(\w+)\.tables/)
	if (saasMatch?.[1] !== undefined) return saasMatch[1]
	/* legacy pattern: db.core.tables.ts -> core */
	const legacyMatch = fileName.match(/^db\.(\w+)\.tables/)
	if (legacyMatch?.[1] !== undefined) return legacyMatch[1]
	/* plain pattern, the README's layout: core.tables.ts -> core */
	const plainMatch = fileName.match(/^(\w+)\.tables\./)
	if (plainMatch?.[1] !== undefined) return plainMatch[1]
	return "db"
}

/** The module specifier `fromFile` imports `target` by: relative, `./` or `../` first, no `.ts` */
export function importPathFrom(fromFile: string, target: string): string {
	const relative = path.relative(path.dirname(fromFile), target).replace(/\.ts$/, "").split(path.sep).join("/")
	return relative.startsWith(".") ? relative : `./${relative}`
}

/**
 * Get the import path for the tables file (without extension), relative to same directory.
 * e.g. test.db.core.tables.gen.ts -> ./test.db.core.tables.gen
 */
export function getTablesImportPath(tablesPath: string): string {
	const basename = path.basename(tablesPath, ".ts")
	return `./${basename}`
}
