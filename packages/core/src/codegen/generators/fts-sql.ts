/**
 * FTS5 SQL generator — pure function that produces CREATE VIRTUAL TABLE + trigger DDL.
 *
 * Shared between:
 * - codegen generator (writes .gen.sql reference files)
 * - migrate diff (appends to migration files)
 */
import type { TableMeta } from "../analyzer-types.ts"

type FtsTableConfig = {
	columns: string[]
	tokenizer?: string
}

const DEFAULT_TOKENIZER = "unicode61 remove_diacritics 2"

/** Validate FTS config against analyzed tables, throw on errors, warn on non-text columns */
function validateFtsConfig(tables: TableMeta[], ftsConfig: Record<string, FtsTableConfig>): void {
	const tableMap = new Map(tables.map((t) => [t.sqlName, t]))

	for (const [tableName, config] of Object.entries(ftsConfig)) {
		const table = tableMap.get(tableName)
		if (!table) {
			throw new Error(`FTS config error: table "${tableName}" not found in analyzed schema`)
		}

		const fieldNames = new Set(table.fields.map((f) => f.name))
		const seen = new Set<string>()

		for (const col of config.columns) {
			if (!fieldNames.has(col)) {
				throw new Error(`FTS config error: column "${col}" not found in table "${tableName}"`)
			}
			if (seen.has(col)) {
				console.warn(`  fts warning: duplicate column "${col}" in table "${tableName}" — skipped`)
			}
			seen.add(col)

			const field = table.fields.find((f) => f.name === col)
			if (field && field.drizzleHelper !== "text" && field.drizzleHelper !== "createdAt") {
				const helper = field.drizzleHelper
				if (helper === "integer" || helper === "boolean" || helper === "timestamp" || helper === "serialId") {
					console.warn(
						`  fts warning: column "${col}" in table "${tableName}" is type ${helper}, will be coerced to text for FTS indexing`,
					)
				}
			}
		}
	}
}

/** Deduplicate columns preserving order */
function dedup(columns: string[]): string[] {
	const seen = new Set<string>()
	const result: string[] = []
	for (const col of columns) {
		if (!seen.has(col)) {
			seen.add(col)
			result.push(col)
		}
	}
	return result
}

/** Generate FTS5 SQL for all configured tables. Returns empty string if nothing to generate. */
function generateFtsSql(tables: TableMeta[], ftsConfig: Record<string, FtsTableConfig>): string {
	const entries = Object.entries(ftsConfig)
	if (entries.length === 0) return ""

	validateFtsConfig(tables, ftsConfig)

	const lines: string[] = []

	for (const [tableName, config] of entries) {
		const columns = dedup(config.columns)
		const tokenizer = config.tokenizer ?? DEFAULT_TOKENIZER
		const ftsTable = `${tableName}_fts`
		const colList = columns.join(", ")

		/* Virtual table */
		lines.push(`CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable} USING fts5(`)
		lines.push(`\t${colList},`)
		lines.push(`\tcontent='${tableName}',`)
		lines.push(`\tcontent_rowid='rowid',`)
		lines.push(`\ttokenize='${tokenizer}'`)
		lines.push(`);`)
		lines.push(``)

		/* Column refs for triggers */
		const newCols = columns.map((c) => `new.${c}`).join(", ")
		const oldCols = columns.map((c) => `old.${c}`).join(", ")

		/* AFTER INSERT */
		lines.push(`CREATE TRIGGER IF NOT EXISTS ${ftsTable}_ai AFTER INSERT ON ${tableName} BEGIN`)
		lines.push(`\tINSERT INTO ${ftsTable}(rowid, ${colList})`)
		lines.push(`\tVALUES (new.rowid, ${newCols});`)
		lines.push(`END;`)
		lines.push(``)

		/* AFTER DELETE */
		lines.push(`CREATE TRIGGER IF NOT EXISTS ${ftsTable}_ad AFTER DELETE ON ${tableName} BEGIN`)
		lines.push(`\tINSERT INTO ${ftsTable}(${ftsTable}, rowid, ${colList})`)
		lines.push(`\tVALUES ('delete', old.rowid, ${oldCols});`)
		lines.push(`END;`)
		lines.push(``)

		/* AFTER UPDATE */
		lines.push(`CREATE TRIGGER IF NOT EXISTS ${ftsTable}_au AFTER UPDATE ON ${tableName} BEGIN`)
		lines.push(`\tINSERT INTO ${ftsTable}(${ftsTable}, rowid, ${colList})`)
		lines.push(`\tVALUES ('delete', old.rowid, ${oldCols});`)
		lines.push(`\tINSERT INTO ${ftsTable}(rowid, ${colList})`)
		lines.push(`\tVALUES (new.rowid, ${newCols});`)
		lines.push(`END;`)
		lines.push(``)
	}

	return lines.join("\n")
}

export { generateFtsSql }
export type { FtsTableConfig }
