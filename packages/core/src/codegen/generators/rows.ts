/**
 * Row type generator — pure transformer from TableMeta[].
 *
 * Generates TypeScript types using Drizzle's $inferSelect and $inferInsert
 */
import path from "node:path"
import { snakeToPascal } from "../utils/case.ts"
import { writeGenFile } from "../utils/fs.ts"
import type { GeneratorContext } from "./context-types.ts"

type RowsConfig = {
	output: string
}

/**
 * Generate row types from analyzed tables
 */
export function generateRows(ctx: GeneratorContext, config: RowsConfig): void {
	const { tables } = ctx.analysis
	const { cwd, tablesPath } = ctx
	const outputPath = path.resolve(cwd, config.output)

	if (tables.length === 0) {
		ctx.warn("rows: no tables found — skipped")
		return
	}

	const outputLines: string[] = []

	/* Generate import statement */
	const outputDir = path.dirname(outputPath)
	let relativePath = path.relative(outputDir, tablesPath).replace(/\.ts$/, "")
	if (!relativePath.startsWith(".")) {
		relativePath = `./${relativePath}`
	}

	outputLines.push("import type {")
	for (const table of tables) {
		outputLines.push(`\t${table.varName},`)
	}
	outputLines.push(`} from "${relativePath}"`)
	outputLines.push("")

	/* Generate row types - both Select and Insert */
	for (const table of tables) {
		const pascalName = snakeToPascal(table.varName)
		outputLines.push(`export type ${pascalName}RowSelect = typeof ${table.varName}.$inferSelect`)
		outputLines.push(`export type ${pascalName}RowInsert = typeof ${table.varName}.$inferInsert`)
	}
	outputLines.push("")

	/* Generate table name union type */
	const tableNameUnion = tables.map((t) => `"${t.varName}"`).join(" | ")
	outputLines.push(`export type RowTableName = ${tableNameUnion}`)
	outputLines.push("")

	writeGenFile(outputPath, outputLines.join("\n"), "comb")

	ctx.log(`Generated rows at: ${outputPath}`)
	ctx.log(`Tables: ${tables.length}`)
}
