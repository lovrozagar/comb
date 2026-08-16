/**
 * Column refs generator — pure transformer from TableMeta[].
 *
 * Generates per-entity into two separate directories:
 *   - rqb-cols: `{ field: true }` for RQB column selection + Zod .pick()
 *   - sql-cols: `{ field: table.field }` for .returning() and raw SQL
 * Both auto-exclude `_private` fields (underscore prefix).
 *
 * Also generates table-names map: `t.entity_name` for raw SQL.
 */
import fs from "node:fs"
import path from "node:path"
import type { TableMeta } from "../analyzer-types.ts"
import { snakeToCamel } from "../utils/case.ts"
import { ensureDir, writeGenFile, writeJsonAtomic } from "../utils/fs.ts"

type ColumnsConfig = {
	filePrefix?: string | undefined
	output: string
	updatePackageJson?: boolean
}

type TableEntry = {
	fields: string[]
	sqlName: string
	varName: string
}

/** Generate column refs and table names from analyzed tables */
export function generateColumns(tables: TableMeta[], tablesPath: string, config: ColumnsConfig, cwd: string): void {
	const absoluteOutputDir = path.resolve(cwd, config.output)
	const rqbColsDir = path.join(absoluteOutputDir, "rqb-cols")
	const sqlColsDir = path.join(absoluteOutputDir, "sql-cols")
	const tableNamesDir = path.join(absoluteOutputDir, "table-names")

	ensureDir(rqbColsDir)
	ensureDir(sqlColsDir)
	ensureDir(tableNamesDir)

	/* Transform TableMeta[] to internal TableEntry[] */
	const entries: TableEntry[] = tables.map((t) => ({
		fields: t.fields
			.filter((f) => !f.constraints.private)
			.map((f) => f.name)
			.sort(),
		sqlName: t.sqlName,
		varName: t.varName,
	}))

	/* Resolve relative import path from entity dirs to tables file */
	const tablesFileBaseName = path.basename(tablesPath, ".ts")
	const tablesFileDir = path.dirname(path.resolve(cwd, tablesPath))

	/* Generate rqb-cols and sql-cols per entity */
	for (const table of entries) {
		const rqbEntityDir = path.join(rqbColsDir, table.varName)
		const sqlEntityDir = path.join(sqlColsDir, table.varName)
		ensureDir(rqbEntityDir)
		ensureDir(sqlEntityDir)

		const sqlRelTablesPath = `${path.relative(sqlEntityDir, tablesFileDir)}/${tablesFileBaseName}`

		const rqbContent = generateRqbColsFile(table)
		const sqlContent = generateSqlColsFile(table, sqlRelTablesPath)

		const rqbFileName = config.filePrefix ? `${config.filePrefix}.${table.varName}.gen.ts` : "index.gen.ts"
		const sqlFileName = config.filePrefix ? `${config.filePrefix}.${table.varName}.gen.ts` : "index.gen.ts"

		const rqbFilePath = path.join(rqbEntityDir, rqbFileName)
		const sqlFilePath = path.join(sqlEntityDir, sqlFileName)

		writeGenFile(rqbFilePath, rqbContent, "comb")
		writeGenFile(sqlFilePath, sqlContent, "comb")
	}

	/* Generate table-names */
	const tableNamesContent = generateTableNamesFile(entries)
	const tableNamesFileName = config.filePrefix ? `${config.filePrefix}.table-names.gen.ts` : "index.gen.ts"
	const tableNamesFilePath = path.join(tableNamesDir, tableNamesFileName)
	writeGenFile(tableNamesFilePath, tableNamesContent, "comb")

	/* Update package.json if requested */
	if (config.updatePackageJson) {
		const packageJsonPath = path.join(cwd, "package.json")
		if (fs.existsSync(packageJsonPath)) {
			updatePackageJson(packageJsonPath, entries, config.output, cwd, config.filePrefix)
		}
	}

	console.log(`Generated column refs for ${entries.length} tables`)
}

/* RQB column selection — { field: true } for db.query.* columns */
function generateRqbColsFile(table: TableEntry): string {
	const camelName = snakeToCamel(table.varName)
	const lines: string[] = [
		"/** RQB column selection + Zod .pick() — { field: true } */",
		`export const ${camelName}RqbCols = {`,
	]

	for (const field of table.fields) {
		lines.push(`\t${field}: true,`)
	}

	lines.push("} as const")
	lines.push("")

	return lines.join("\n")
}

/* SQL column refs — { field: table.field } for .returning() and raw SQL */
function generateSqlColsFile(table: TableEntry, relativeTablesPath: string): string {
	const camelName = snakeToCamel(table.varName)
	const lines: string[] = [
		`import { ${table.varName} } from "${relativeTablesPath}"`,
		"",
		"/** Drizzle column refs — for .returning() and raw SQL */",
		`export const ${camelName}SqlCols = {`,
	]

	for (const field of table.fields) {
		lines.push(`\t${field}: ${table.varName}.${field},`)
	}

	lines.push("}")
	lines.push("")

	return lines.join("\n")
}

function generateTableNamesFile(tables: TableEntry[]): string {
	const lines: string[] = [
		"/** Static table names for raw SQL queries — zero runtime overhead */",
		"export const t = {",
	]

	for (const table of tables) {
		lines.push(`\t${table.varName}: "${table.sqlName}",`)
	}

	lines.push("} as const")
	lines.push("")

	return lines.join("\n")
}

function updatePackageJson(
	packageJsonPath: string,
	tables: TableEntry[],
	outputDir: string,
	cwd: string,
	filePrefix?: string | undefined,
): void {
	const content = fs.readFileSync(packageJsonPath, "utf-8")
	const pkg = JSON.parse(content) as Record<string, unknown>

	const packageDir = path.dirname(packageJsonPath)
	const absoluteOutputDir = path.resolve(cwd, outputDir)
	const relativeOutputDir = `./${path.relative(packageDir, absoluteOutputDir)}`

	const existingExports = (pkg["exports"] ?? {}) as Record<string, string>
	const newExports: Record<string, string> = {}

	/* Preserve non-generated exports */
	for (const [key, value] of Object.entries(existingExports)) {
		if (
			!key.startsWith("./table-cols/") &&
			!key.startsWith("./rqb-cols/") &&
			!key.startsWith("./sql-cols/") &&
			key !== "./table-names"
		) {
			newExports[key] = value as string
		}
	}

	/* Add rqb-cols and sql-cols per entity */
	for (const table of tables) {
		const colFileName = filePrefix ? `${filePrefix}.${table.varName}.gen.ts` : "index.gen.ts"
		newExports[`./rqb-cols/${table.varName}`] = `${relativeOutputDir}/rqb-cols/${table.varName}/${colFileName}`
		newExports[`./sql-cols/${table.varName}`] = `${relativeOutputDir}/sql-cols/${table.varName}/${colFileName}`
	}

	/* Add table-names */
	const tableNamesFileName = filePrefix ? `${filePrefix}.table-names.gen.ts` : "index.gen.ts"
	newExports["./table-names"] = `${relativeOutputDir}/table-names/${tableNamesFileName}`

	pkg["exports"] = newExports

	writeJsonAtomic(packageJsonPath, pkg)
}
