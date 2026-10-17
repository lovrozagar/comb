/**
 * Column refs generator — pure transformer from TableMeta[].
 *
 * Generates per-entity into two separate directories:
 *   - rqb-cols: `{ field: true }` for RQB column selection + Zod .pick()
 *   - sql-cols: `{ field: table.field }` for .returning() and raw SQL
 * Both leave out fields marked `{ private: true }`.
 *
 * Also generates table-names map: `t.entity_name` for raw SQL.
 */
import fs from "node:fs"
import path from "node:path"
import { snakeToCamel } from "../utils/case.ts"
import { ensureDir, writeGenFile, writeJsonAtomic } from "../utils/fs.ts"
import { type ExportTarget, readExports } from "../utils/package-json.ts"
import type { GeneratorContext } from "./context-types.ts"

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

/** A generated file's name: `<prefix>.<stem>.gen.ts` under a prefix, else the directory's `index.gen.ts` */
function genFileName(filePrefix: string | undefined, stem: string): string {
	return filePrefix ? `${filePrefix}.${stem}.gen.ts` : "index.gen.ts"
}

/** Where one run writes: the output directory and the tables file the sql-cols import */
type ColumnsOutput = { absoluteOutputDir: string; filePrefix?: string | undefined; tablesFile: string }

/** Write one table's rqb-cols and sql-cols files */
function writeEntityCols(table: TableEntry, out: ColumnsOutput): void {
	const rqbEntityDir = path.join(out.absoluteOutputDir, "rqb-cols", table.varName)
	const sqlEntityDir = path.join(out.absoluteOutputDir, "sql-cols", table.varName)
	ensureDir(rqbEntityDir)
	ensureDir(sqlEntityDir)
	const sqlRelTablesPath = `${path.relative(sqlEntityDir, path.dirname(out.tablesFile))}/${path.basename(out.tablesFile, ".ts")}`
	const fileName = genFileName(out.filePrefix, table.varName)
	writeGenFile(path.join(rqbEntityDir, fileName), generateRqbColsFile(table), "comb")
	writeGenFile(path.join(sqlEntityDir, fileName), generateSqlColsFile(table, sqlRelTablesPath), "comb")
}

/** Generate column refs and table names from analyzed tables */
export function generateColumns(ctx: GeneratorContext, config: ColumnsConfig): void {
	const out: ColumnsOutput = {
		absoluteOutputDir: path.resolve(ctx.cwd, config.output),
		filePrefix: config.filePrefix,
		tablesFile: path.resolve(ctx.cwd, ctx.tablesPath),
	}
	const entries: TableEntry[] = ctx.analysis.tables.map((t) => ({
		fields: t.fields
			.filter((f) => !f.constraints.private)
			.map((f) => f.name)
			.sort(),
		sqlName: t.sqlName,
		varName: t.varName,
	}))

	for (const dir of ["rqb-cols", "sql-cols", "table-names"]) ensureDir(path.join(out.absoluteOutputDir, dir))
	for (const table of entries) writeEntityCols(table, out)
	const tableNamesFile = path.join(out.absoluteOutputDir, "table-names", genFileName(config.filePrefix, "table-names"))
	writeGenFile(tableNamesFile, generateTableNamesFile(entries), "comb")

	const packageJsonPath = path.join(ctx.cwd, "package.json")
	if (config.updatePackageJson && fs.existsSync(packageJsonPath)) updatePackageJson(packageJsonPath, entries, out)

	ctx.log(`Generated column refs for ${entries.length} tables`)
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

const GENERATED_EXPORT = /^\.\/(?:table-cols|rqb-cols|sql-cols)\/|^\.\/table-names$/

function updatePackageJson(
	packageJsonPath: string,
	tables: TableEntry[],
	{ absoluteOutputDir, filePrefix }: ColumnsOutput,
): void {
	const content = fs.readFileSync(packageJsonPath, "utf-8")
	const pkg = JSON.parse(content) as Record<string, unknown>

	const packageDir = path.dirname(packageJsonPath)
	const relativeOutputDir = `./${path.relative(packageDir, absoluteOutputDir)}`

	const existingExports = readExports(pkg)
	const newExports: Record<string, ExportTarget> = {}

	/* Preserve non-generated exports */
	for (const [key, value] of Object.entries(existingExports)) {
		if (!GENERATED_EXPORT.test(key)) newExports[key] = value
	}

	/* Add rqb-cols and sql-cols per entity */
	for (const table of tables) {
		const colFileName = genFileName(filePrefix, table.varName)
		newExports[`./rqb-cols/${table.varName}`] = `${relativeOutputDir}/rqb-cols/${table.varName}/${colFileName}`
		newExports[`./sql-cols/${table.varName}`] = `${relativeOutputDir}/sql-cols/${table.varName}/${colFileName}`
	}

	/* Add table-names */
	const tableNamesFileName = genFileName(filePrefix, "table-names")
	newExports["./table-names"] = `${relativeOutputDir}/table-names/${tableNamesFileName}`

	pkg["exports"] = newExports

	writeJsonAtomic(packageJsonPath, pkg)
}
