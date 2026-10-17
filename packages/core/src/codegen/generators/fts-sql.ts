/**
 * FTS5 SQL generator — pure function that produces CREATE VIRTUAL TABLE + trigger DDL.
 *
 * Shared between:
 * - codegen generator (writes .gen.sql reference files)
 * - migrate diff (appends to migration files)
 */
import type { FieldMeta, TableMeta } from "../analyzer-types.ts"

type FtsTableConfig = {
	columns: string[]
	tokenizer?: string
}

const DEFAULT_TOKENIZER = "unicode61 remove_diacritics 2"

/** The field a configured FTS column names, by property or by SQL name. */
function fieldOf(table: TableMeta, column: string): FieldMeta | undefined {
	return table.fields.find((f) => f.name === column) ?? table.fields.find((f) => f.sqlName === column)
}

// lookup-table: the helpers whose values FTS5 indexes as their text form
const COERCED_HELPERS = /* @__PURE__ */ new Set(["boolean", "integer", "serialId", "timestamp"])

/** Throw on a column the table lacks; warn on a repeat or a column FTS coerces to text. */
function validateColumns(table: TableMeta, config: FtsTableConfig, warn: (line: string) => void): void {
	const tableName = table.sqlName
	const seen = new Set<string>()
	for (const col of config.columns) {
		const field = fieldOf(table, col)
		if (field === undefined) {
			throw new Error(`FTS config error: column "${col}" not found in table "${tableName}"`)
		}
		if (seen.has(col)) warn(`  fts warning: duplicate column "${col}" in table "${tableName}" — skipped`)
		seen.add(col)
		if (COERCED_HELPERS.has(field.drizzleHelper)) {
			warn(
				`  fts warning: column "${col}" in table "${tableName}" is type ${field.drizzleHelper}, will be coerced to text for FTS indexing`,
			)
		}
	}
}

/** Validate FTS config against analyzed tables, throw on errors, warn on non-text columns */
function validateFtsConfig(
	tables: TableMeta[],
	ftsConfig: Record<string, FtsTableConfig>,
	warn: (line: string) => void,
): void {
	const tableMap = new Map(tables.map((t) => [t.sqlName, t]))
	for (const [tableName, config] of Object.entries(ftsConfig)) {
		const table = tableMap.get(tableName)
		if (!table) {
			throw new Error(`FTS config error: table "${tableName}" not found in analyzed schema`)
		}
		validateColumns(table, config, warn)
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
function generateFtsSql(
	tables: TableMeta[],
	ftsConfig: Record<string, FtsTableConfig>,
	warn: (line: string) => void,
): string {
	const entries = Object.entries(ftsConfig)
	if (entries.length === 0) return ""

	validateFtsConfig(tables, ftsConfig, warn)

	const lines: string[] = []

	const tableMap = new Map(tables.map((t) => [t.sqlName, t]))
	for (const [tableName, config] of entries) {
		const table = tableMap.get(tableName) as TableMeta
		/* triggers run in SQL, so they name the SQL columns */
		const columns = dedup(config.columns.map((col) => (fieldOf(table, col) as FieldMeta).sqlName))
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

export { dedup, generateFtsSql }
export type { FtsTableConfig }
