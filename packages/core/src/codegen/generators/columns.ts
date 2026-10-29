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
import { propertyAccess, propertyName, snakeToCamel, stringLiteral, subpathName } from "../utils/case.ts"
import { readStaged, type Staged, writeGenFile, writeJsonAtomic } from "../utils/fs.ts"
import { exportKey, type ExportTarget, ownsKey, readExports } from "../utils/package-json.ts"
import type { GeneratorContext } from "./context-types.ts"
import { qualifiedName } from "../utils/table-name.ts"
import { type ImportStyle, specifierFor } from "../utils/paths.ts"

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
type ColumnsOutput = {
	absoluteOutputDir: string
	filePrefix?: string | undefined
	importStyle: ImportStyle | undefined
	tablesFile: string
}

/** Write one table's rqb-cols and sql-cols files */
function writeEntityCols(table: TableEntry, out: ColumnsOutput, staged: Staged | undefined): void {
	const segment = subpathName(table.varName)
	const rqbEntityDir = path.join(out.absoluteOutputDir, "rqb-cols", segment)
	const sqlEntityDir = path.join(out.absoluteOutputDir, "sql-cols", segment)
	const sqlRelTablesPath = specifierFor(sqlEntityDir, out.tablesFile, out.importStyle)
	const fileName = genFileName(out.filePrefix, segment)
	writeGenFile(path.join(rqbEntityDir, fileName), generateRqbColsFile(table), { generator: "comb", staged })
	writeGenFile(path.join(sqlEntityDir, fileName), generateSqlColsFile(table, sqlRelTablesPath), {
		generator: "comb",
		staged,
	})
}

/** Generate column refs and table names from analyzed tables */
export function generateColumns(ctx: GeneratorContext, config: ColumnsConfig): void {
	const out: ColumnsOutput = {
		absoluteOutputDir: path.resolve(ctx.cwd, config.output),
		filePrefix: config.filePrefix,
		importStyle: ctx.importStyle,
		tablesFile: path.resolve(ctx.cwd, ctx.tablesPath),
	}
	const entries: TableEntry[] = ctx.analysis.tables.map((t) => ({
		fields: t.fields
			.filter((f) => !f.constraints.private)
			.map((f) => f.name)
			.sort(),
		/* auth.users for a pgSchema's table, which a bare users would send raw SQL to another (F51) */
		sqlName: qualifiedName(t),
		varName: t.varName,
	}))

	for (const table of entries) writeEntityCols(table, out, ctx.staged)
	const tableNamesFile = path.join(out.absoluteOutputDir, "table-names", genFileName(config.filePrefix, "table-names"))
	writeGenFile(tableNamesFile, generateTableNamesFile(entries), { generator: "comb", staged: ctx.staged })

	const packageJsonPath = path.join(ctx.cwd, "package.json")
	if (config.updatePackageJson && fs.existsSync(packageJsonPath))
		updatePackageJson(packageJsonPath, entries, { ...out, namespace: ctx.exportNamespace, staged: ctx.staged })

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
		lines.push(`\t${propertyName(field)}: true,`)
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
		lines.push(`\t${propertyName(field)}: ${propertyAccess(table.varName, field)},`)
	}

	lines.push("}")
	lines.push("")

	return lines.join("\n")
}

function generateTableNamesFile(tables: TableEntry[]): string {
	const lines: string[] = [
		"/**",
		" * Static table names for raw SQL queries — zero runtime overhead. A pgSchema table's name is",
		" * schema-qualified and unquoted (`auth.users`): splice it into the SQL text, never through",
		" * sql.identifier(), which would quote it as one name, a table called `auth.users`",
		" */",
		"export const t = {",
	]

	for (const table of tables) {
		lines.push(`\t${table.varName}: ${stringLiteral(table.sqlName)},`)
	}

	lines.push("} as const")
	lines.push("")

	return lines.join("\n")
}

const GENERATED_EXPORT = /^\.\/(?:table-cols|rqb-cols|sql-cols)\/|^\.\/table-names$/

function updatePackageJson(
	packageJsonPath: string,
	tables: TableEntry[],
	{
		absoluteOutputDir,
		filePrefix,
		namespace,
		staged,
	}: ColumnsOutput & { namespace: string | undefined; staged: Staged | undefined },
): void {
	const content = readStaged(packageJsonPath, staged)
	const pkg = JSON.parse(content) as Record<string, unknown>

	const packageDir = path.dirname(packageJsonPath)
	const relativeOutputDir = `./${path.relative(packageDir, absoluteOutputDir)}`

	const existingExports = readExports(pkg)
	const newExports: Record<string, ExportTarget> = {}

	/* Preserve every export but this database's generated ones */
	for (const [key, value] of Object.entries(existingExports)) {
		if (!ownsKey(namespace, key, (bare) => GENERATED_EXPORT.test(bare))) newExports[key] = value
	}

	/* Add rqb-cols and sql-cols per entity */
	for (const table of tables) {
		/* one kebab-case name for every generated subpath, the DTOs' too (C20) */
		const segment = subpathName(table.varName)
		const colFileName = genFileName(filePrefix, segment)
		newExports[exportKey(namespace, `./rqb-cols/${segment}`)] =
			`${relativeOutputDir}/rqb-cols/${segment}/${colFileName}`
		newExports[exportKey(namespace, `./sql-cols/${segment}`)] =
			`${relativeOutputDir}/sql-cols/${segment}/${colFileName}`
	}

	/* Add table-names */
	const tableNamesFileName = genFileName(filePrefix, "table-names")
	newExports[exportKey(namespace, "./table-names")] = `${relativeOutputDir}/table-names/${tableNamesFileName}`

	pkg["exports"] = newExports

	writeJsonAtomic(packageJsonPath, pkg, staged)
}
