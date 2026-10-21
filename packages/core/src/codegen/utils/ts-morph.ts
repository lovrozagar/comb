/**
 * Shared ts-morph helpers
 */
import path from "node:path"
import type { Node, SourceFile } from "ts-morph"
import { Project, SyntaxKind } from "ts-morph"
import { stringOf } from "./enum-source.ts"

/** Create a ts-morph project optimized for code generation */
export function createProject(): Project {
	return new Project({
		/* codegen resolves only the consumer's own declarations; loading TypeScript's lib files on
		   the first type-checker use cost about a second per project and nothing read them */
		compilerOptions: { noLib: true },
		skipAddingFilesFromTsConfig: true,
		skipFileDependencyResolution: true,
	})
}

/**
 * Create a ts-morph project and add all .ts files from the tables file directory.
 * This follows re-exports from preset files.
 */
/**
 * The files whose tables belong to the database of `tablesPath`: the tables file and every file
 * it re-exports from (`export * from`, `export { x } from`), followed through re-exports. The
 * project loads the whole directory to resolve names, and other databases' tables files, or a
 * test's fixture tables, live there too.
 */
export function tableSourceFiles(project: Project, tablesPath: string): SourceFile[] {
	const first = project.getSourceFile(path.resolve(tablesPath))
	const out: SourceFile[] = []
	const queue = first === undefined ? [] : [first]
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		if (out.includes(file)) continue
		out.push(file)
		for (const declaration of file.getExportDeclarations()) {
			const target = declaration.getModuleSpecifierSourceFile()
			if (target !== undefined) queue.push(target)
		}
	}
	return out
}

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

/**
 * The SQL name an argument spells: a string literal, or a const that holds one. Anything else is
 * an error at the argument: a name comb guessed would key every generated map on the wrong one.
 */
export function sqlNameArg(arg: Node): string {
	const name = stringOf(arg)
	if (name !== null) return name
	throw new Error(
		`${arg.getSourceFile().getFilePath()}:${arg.getStartLineNumber()}: comb cannot read the SQL name ${arg.getText()}; write it as a string, or a const that holds one`,
	)
}

/** The table name a table definition call declares: its first argument, else its variable's name */
export function getTableName(variableName: string, initializer: Node): string {
	const first = initializer.asKind(SyntaxKind.CallExpression)?.getArguments()[0]
	return first === undefined ? variableName : sqlNameArg(first)
}
