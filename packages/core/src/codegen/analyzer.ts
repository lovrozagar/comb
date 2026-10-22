/**
 * TableAnalyzer — single-pass ts-morph AST traversal.
 *
 * Produces TableMeta[] consumed by all generators as pure transformers.
 * Centralizes all AST parsing so generators never touch ts-morph.
 */
import type { Project } from "ts-morph"
import { parseTable } from "./analyze-table.ts"
import type { AnalysisResult, ImportsMeta, TableMeta } from "./analyzer-types.ts"
import { builderDialects, calleeOf, isTableDefinition, tableBuilders } from "./utils/table-builders.ts"
import { createProjectFromTablesDir, extractDbName, getTablesImportPath, tableSourceFiles } from "./utils/ts-morph.ts"

/** Every named import across the project, by local name, with the module it comes from. */
function collectImports(project: Project): ImportsMeta {
	const imports: ImportsMeta = {
		enumImports: new Map(),

		identifiers: new Map(),
		jsonSchemaImports: new Set(),
	}
	for (const file of project.getSourceFiles()) {
		for (const declaration of file.getImportDeclarations()) {
			const moduleSpecifier = declaration.getModuleSpecifierValue()
			for (const named of declaration.getNamedImports()) imports.identifiers.set(named.getName(), moduleSpecifier)
		}
	}
	return imports
}

/**
 * Every table the tables file declares, itself or through a file it re-exports, and the engine
 * their builders build for; tables of both engines in one database are refused
 */
function collectTables(
	project: Project,
	tablesPath: string,
	imports: ImportsMeta,
): Pick<AnalysisResult, "dialect" | "tables"> {
	const tables: TableMeta[] = []
	const dialects = new Set<"postgres" | "sqlite">()
	for (const file of tableSourceFiles(project, tablesPath)) {
		const builders = tableBuilders(file)
		const engines = builderDialects(file)
		for (const statement of file.getVariableStatements()) {
			const declaration = statement.getDeclarations()[0]
			const text = declaration?.getInitializer()?.getText()
			if (declaration === undefined || text === undefined || !isTableDefinition(text, builders)) continue
			const table = parseTable(declaration, imports)
			if (table === null) continue
			tables.push(table)
			const engine = engines.get(calleeOf(text) as string)
			if (engine !== undefined) dialects.add(engine)
		}
	}
	if (dialects.size > 1)
		throw new Error(
			`${tablesPath}: the database holds both Postgres and SQLite tables; give each engine its own database`,
		)
	return { dialect: [...dialects][0] ?? null, tables: tables.sort((a, b) => a.varName.localeCompare(b.varName)) }
}

/**
 * Analyze a tables file and produce the full AnalysisResult.
 * Single-pass ts-morph traversal — all generators consume this output.
 */
function analyze(tablesPath: string): AnalysisResult {
	const project = createProjectFromTablesDir(tablesPath)
	const imports = collectImports(project)
	return {
		dbName: extractDbName(tablesPath),
		imports,
		...collectTables(project, tablesPath, imports),
		tablesImportPath: getTablesImportPath(tablesPath),
	}
}

export { analyze }
export type { AnalysisResult, TableMeta }
