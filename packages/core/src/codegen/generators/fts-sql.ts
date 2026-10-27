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

/* combining marks count as word characters (M*): unicode61's default categories split a word at each
   one, so Devanagari, Hebrew and Arabic words were indexed as consonant fragments (U32) */
const DEFAULT_TOKENIZER = "unicode61 remove_diacritics 2 categories 'L* N* Co M*'"

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

/** An SQL identifier, double-quoted: a table or column may be named by a keyword (`order`, `group`) */
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`

/** An SQL string literal */
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`

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

/** One table's fts5 virtual table and the three triggers that keep it in step with the table */
function groupLines(tableName: string, columns: string[], tokenizer: string): string[] {
	const lines: string[] = []
	const ftsTable = ident(`${tableName}_fts`)
	const source = ident(tableName)
	const colList = columns.map(ident).join(", ")
	const trigger = (suffix: string) => ident(`${tableName}_fts_${suffix}`)

	/* Virtual table */
	lines.push(`CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable} USING fts5(`)
	lines.push(`\t${colList},`)
	lines.push(`\tcontent=${literal(tableName)},`)
	lines.push(`\tcontent_rowid='rowid',`)
	lines.push(`\ttokenize=${literal(tokenizer)}`)
	lines.push(`);`)
	lines.push(``)

	/* Column refs for triggers */
	const newCols = columns.map((c) => `new.${ident(c)}`).join(", ")
	const oldCols = columns.map((c) => `old.${ident(c)}`).join(", ")

	/* AFTER INSERT */
	lines.push(`CREATE TRIGGER IF NOT EXISTS ${trigger("ai")} AFTER INSERT ON ${source} BEGIN`)
	lines.push(`\tINSERT INTO ${ftsTable}(rowid, ${colList})`)
	lines.push(`\tVALUES (new.rowid, ${newCols});`)
	lines.push(`END;`)
	lines.push(``)

	/* AFTER DELETE */
	lines.push(`CREATE TRIGGER IF NOT EXISTS ${trigger("ad")} AFTER DELETE ON ${source} BEGIN`)
	lines.push(`\tINSERT INTO ${ftsTable}(${ftsTable}, rowid, ${colList})`)
	lines.push(`\tVALUES ('delete', old.rowid, ${oldCols});`)
	lines.push(`END;`)
	lines.push(``)

	/* AFTER UPDATE */
	lines.push(`CREATE TRIGGER IF NOT EXISTS ${trigger("au")} AFTER UPDATE ON ${source} BEGIN`)
	lines.push(`\tINSERT INTO ${ftsTable}(${ftsTable}, rowid, ${colList})`)
	lines.push(`\tVALUES ('delete', old.rowid, ${oldCols});`)
	lines.push(`\tINSERT INTO ${ftsTable}(rowid, ${colList})`)
	lines.push(`\tVALUES (new.rowid, ${newCols});`)
	lines.push(`END;`)
	lines.push(``)
	return lines
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
		const columns = ftsColumns(table, config.columns)
		lines.push(...groupLines(tableName, columns, config.tokenizer ?? DEFAULT_TOKENIZER))
	}

	return lines.join("\n")
}

/**
 * The FTS SQL a person applies by hand: each configured index's triggers and table dropped, made
 * again, and rebuilt from its content table, so applying it after a column change replaces the
 * old index rather than leaving it in place. `comb migrate diff` takes generateFtsSql, and writes
 * a changed index this way itself.
 */
function ftsReferenceSql(
	tables: TableMeta[],
	ftsConfig: Record<string, FtsTableConfig>,
	warn: (line: string) => void,
): string {
	const create = generateFtsSql(tables, ftsConfig, warn)
	if (create === "") return ""
	const names = Object.keys(ftsConfig)
	const drops = names.flatMap((name) => [
		...["ai", "ad", "au"].map((suffix) => `DROP TRIGGER IF EXISTS ${ident(`${name}_fts_${suffix}`)};`),
		`DROP TABLE IF EXISTS ${ident(`${name}_fts`)};`,
	])
	const rebuilds = names.map(
		(name) => `INSERT INTO ${ident(`${name}_fts`)}(${ident(`${name}_fts`)}) VALUES ('rebuild');`,
	)
	return [...drops, "", create, ...rebuilds, ""].join("\n")
}

/** The SQL columns of an FTS index configured on `table` as `columns`, each once */
const ftsColumns = (table: TableMeta, columns: readonly string[]): string[] =>
	dedup(columns.map((col) => (fieldOf(table, col) as FieldMeta).sqlName))

export { dedup, DEFAULT_TOKENIZER, ftsColumns, ftsReferenceSql, generateFtsSql }
export type { FtsTableConfig }
