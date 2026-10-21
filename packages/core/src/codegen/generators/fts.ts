/**
 * FTS5 generator — produces SQL + TypeScript from comb.config.ts fts config.
 *
 * Outputs:
 * - db.{dbName}.fts.gen.sql  — CREATE VIRTUAL TABLE + trigger DDL
 * - db.{dbName}.fts.gen.ts   — type-safe FTS table metadata map
 */
import path from "node:path"
import { dbIdentifiers, propertyName, stringLiteral } from "../utils/case.ts"
import { writeGenFile } from "../utils/fs.ts"
import { ftsColumns, ftsReferenceSql, type FtsTableConfig } from "./fts-sql.ts"
import type { TableMeta } from "../analyzer-types.ts"
import type { GeneratorContext } from "./context-types.ts"

type FtsGeneratorConfig = {
	/** file name stem; defaults to `db.<dbName>` */
	filePrefix?: string | undefined
	fts: Record<string, FtsTableConfig>
	output: string
}

function generateFts(ctx: GeneratorContext, config: FtsGeneratorConfig): void {
	const { dbName, tables } = ctx.analysis
	const { cwd } = ctx
	const filePrefix = config.filePrefix ?? `db.${dbName}`
	const entries = Object.entries(config.fts)
	if (entries.length === 0) {
		ctx.log("  fts: no fts config — skipped")
		return
	}

	const outputDir = path.resolve(cwd, config.output)

	/* SQL file */
	const sql = ftsReferenceSql(tables, config.fts, ctx.warn)

	const sqlPath = path.join(outputDir, `${filePrefix}.fts.gen.sql`)
	writeGenFile(sqlPath, sql, { generator: "comb", staged: ctx.staged })
	ctx.log(`  fts: ${sqlPath} (${entries.length} table${entries.length > 1 ? "s" : ""})`)

	/* TypeScript file */
	const constName = `${dbIdentifiers(dbName).constant}_DB_FTS`
	const tsLines: string[] = []

	tsLines.push(`const ${constName} = {`)

	for (const [tableName, tableConfig] of entries) {
		/* the SQL columns, as the FTS table has them (validated by ftsReferenceSql above) */
		const columns = ftsColumns(tables.find((table) => table.sqlName === tableName) as TableMeta, tableConfig.columns)

		tsLines.push(`\t${propertyName(tableName)}: {`)
		tsLines.push(`\t\tcolumns: [${columns.map((c) => stringLiteral(c)).join(", ")}] as const,`)
		tsLines.push(`\t\tftsTable: ${stringLiteral(`${tableName}_fts`)},`)
		tsLines.push(`\t\tsourceTable: ${stringLiteral(tableName)},`)
		tsLines.push(`\t},`)
	}

	tsLines.push("} as const")
	tsLines.push("")
	tsLines.push(`export { ${constName} }`)
	tsLines.push("")

	const tsPath = path.join(outputDir, `${filePrefix}.fts.gen.ts`)
	writeGenFile(tsPath, tsLines.join("\n"), { generator: "comb", staged: ctx.staged })
	ctx.log(`  fts: ${tsPath}`)
}

export { generateFts }
