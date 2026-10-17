/**
 * Shared ts-morph helpers
 */
import path from "node:path"
import type { Node } from "ts-morph"
import { Project, SyntaxKind } from "ts-morph"

/** Create a ts-morph project optimized for code generation */
export function createProject(): Project {
	return new Project({
		skipAddingFilesFromTsConfig: true,
		skipFileDependencyResolution: true,
	})
}

/**
 * Create a ts-morph project and add all .ts files from the tables file directory.
 * This follows re-exports from preset files.
 */
export function createProjectFromTablesDir(tablesPath: string): Project {
	const project = createProject()
	const srcDir = path.dirname(tablesPath)
	/* Only the consumer's own sources. A tables file at a project root would
	   otherwise sweep node_modules and analyze every dependency's tables —
	   including comb's own — reporting findings against code the consumer
	   neither wrote nor can change. */
	project.addSourceFilesAtPaths([
		`${srcDir}/**/*.ts`,
		`!${srcDir}/**/node_modules/**`,
		`!${srcDir}/**/dist/**`,
		`!${srcDir}/**/build/**`,
		`!${srcDir}/**/coverage/**`,
		`!${srcDir}/**/.wrangler/**`,
	])
	return project
}

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
	return "db"
}

/**
 * Get the import path for the tables file (without extension), relative to same directory.
 * e.g. test.db.core.tables.gen.ts -> ./test.db.core.tables.gen
 */
export function getTablesImportPath(tablesPath: string): string {
	const basename = path.basename(tablesPath, ".ts")
	return `./${basename}`
}

/** Get actual table name from table definition call */
export function getTableName(variableName: string, initializer: Node): string {
	const callExpr = initializer.asKind(SyntaxKind.CallExpression)
	if (!callExpr) return variableName

	const args = callExpr.getArguments()
	const firstArg = args[0]
	if (firstArg) {
		return firstArg.getText().replace(/['"]/g, "")
	}
	return variableName
}
