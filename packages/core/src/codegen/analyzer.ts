/**
 * TableAnalyzer — single-pass ts-morph AST traversal.
 *
 * Produces TableMeta[] consumed by all generators as pure transformers.
 * Centralizes all AST parsing so generators never touch ts-morph.
 */
import type { Project } from "ts-morph"
import { parseTable } from "./analyze-table.ts"
import type { AnalysisResult, ImportsMeta, TableMeta } from "./analyzer-types.ts"
import { isTableDefinition, tableBuilders } from "./utils/table-builders.ts"
import {
	buildIdentifierValueMap,
	createProjectFromTablesDir,
	extractDbName,
	getTablesImportPath,
	setIdentifierValueMap,
} from "./utils/ts-morph.ts"

/** Every named import across the project, by local name, with the module it comes from. */
function collectImports(project: Project): ImportsMeta {
	const imports: ImportsMeta = { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() }
	for (const file of project.getSourceFiles()) {
		for (const declaration of file.getImportDeclarations()) {
			const moduleSpecifier = declaration.getModuleSpecifierValue()
			for (const named of declaration.getNamedImports()) imports.identifiers.set(named.getName(), moduleSpecifier)
		}
	}
	return imports
}

/** Every table the project's files declare. */
function collectTables(project: Project, imports: ImportsMeta): TableMeta[] {
	const tables: TableMeta[] = []
	for (const file of project.getSourceFiles()) {
		const builders = tableBuilders(file)
		for (const statement of file.getVariableStatements()) {
			const declaration = statement.getDeclarations()[0]
			const text = declaration?.getInitializer()?.getText()
			if (declaration === undefined || text === undefined || !isTableDefinition(text, builders)) continue
			const table = parseTable(declaration, imports)
			if (table !== null) tables.push(table)
		}
	}
	return tables.sort((a, b) => a.varName.localeCompare(b.varName))
}

/**
 * Analyze a tables file and produce the full AnalysisResult.
 * Single-pass ts-morph traversal — all generators consume this output.
 */
function analyze(tablesPath: string, cwd?: string): AnalysisResult {
	const project = createProjectFromTablesDir(tablesPath)
	const imports = collectImports(project)
	/* Resolve imported identifier values for constraint pattern resolution */
	if (cwd) setIdentifierValueMap(buildIdentifierValueMap(imports.identifiers, cwd))
	return {
		dbName: extractDbName(tablesPath),
		imports,
		tables: collectTables(project, imports),
		tablesImportPath: getTablesImportPath(tablesPath),
	}
}

export { analyze }
export type { AnalysisResult, TableMeta }
