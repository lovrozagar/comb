/**
 * FTS5 generator — produces SQL + TypeScript from comb.config.ts fts config.
 *
 * Outputs:
 * - db.{dbName}.fts.gen.sql  — CREATE VIRTUAL TABLE + trigger DDL
 * - db.{dbName}.fts.gen.ts   — type-safe FTS table metadata map
 */
import path from "node:path"
import type { TableMeta } from "../analyzer-types.ts"
import { toScreamingSnakeCase } from "../utils/case.ts"
import { writeGenFile } from "../utils/fs.ts"
import { generateFtsSql, type FtsTableConfig } from "./fts-sql.ts"

type FtsGeneratorConfig = {
	fts: Record<string, FtsTableConfig>
	output: string
}

function generateFts(tables: TableMeta[], dbName: string, config: FtsGeneratorConfig, cwd: string): void {
	const entries = Object.entries(config.fts)
	if (entries.length === 0) {
		console.log("  fts: no fts config — skipped")
		return
	}

	const outputDir = path.resolve(cwd, config.output)

	/* SQL file */
	const sql = generateFtsSql(tables, config.fts)
	if (!sql) return

	const sqlPath = path.join(outputDir, `db.${dbName}.fts.gen.sql`)
	writeGenFile(sqlPath, sql, "comb")
	console.log(`  fts: ${sqlPath} (${entries.length} table${entries.length > 1 ? "s" : ""})`)

	/* TypeScript file */
	const constName = `${toScreamingSnakeCase(dbName)}_DB_FTS`
	const tsLines: string[] = []

	tsLines.push(`const ${constName} = {`)

	for (const [tableName, tableConfig] of entries) {
		/* Deduplicate columns preserving order */
		const seen = new Set<string>()
		const columns: string[] = []
		for (const col of tableConfig.columns) {
			if (!seen.has(col)) {
				seen.add(col)
				columns.push(col)
			}
		}

		tsLines.push(`\t${tableName}: {`)
		tsLines.push(`\t\tcolumns: [${columns.map((c) => `"${c}"`).join(", ")}] as const,`)
		tsLines.push(`\t\tftsTable: "${tableName}_fts",`)
		tsLines.push(`\t\tsourceTable: "${tableName}",`)
		tsLines.push(`\t},`)
	}

	tsLines.push("} as const")
	tsLines.push("")
	tsLines.push(`export { ${constName} }`)
	tsLines.push("")

	const tsPath = path.join(outputDir, `db.${dbName}.fts.gen.ts`)
	writeGenFile(tsPath, tsLines.join("\n"), "comb")
	console.log(`  fts: ${tsPath}`)
}

export { generateFts }
