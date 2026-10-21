/**
 * The rowids of an Atlas table rebuild. A table whose key is its rowid keeps them with its key;
 * any other rowid table carries them apart, in the guard's keep table and, for the rebuilt table,
 * in Atlas's copy, rewritten to `INSERT INTO new_T (rowid, …) SELECT rowid, …`, as far as D1's
 * cap on a SELECT's columns lets them fit.
 */
import type { ExtractedSchema, TableInfo } from "../types.ts"
import { lastPart, QNAME, splitTopLevel } from "./sql-code.ts"

/**
 * D1's cap on a result set's columns. On wrangler --local (2026-10-21) a 100-column table and an
 * INSERT of rowid and 100 VALUES work, while `SELECT rowid, <100 columns>` and `CREATE TABLE … AS`
 * from it fail with "too many columns in result set". SQLite's own default is 2000.
 */
const D1_RESULT_COLUMNS = 100

/** `name` as a backtick-quoted identifier */
const quote = (name: string): string => `\`${name.replaceAll("`", "``")}\``

/** An Atlas rebuild: `table` copied into `temp`, dropped, and `temp` renamed onto it */
type Rebuild = { table: string; temp: string }

/** The columns an INSERT may write: every column but the generated ones */
function stored(table: string, schema: ExtractedSchema): string[] {
	const generated = schema.tableInfo.get(table)?.generatedColumns ?? []
	return (schema.tables.get(table) ?? []).filter((column) => !generated.includes(column))
}

/** A table whose rows must carry their rowid apart: a rowid table whose key is not the rowid */
const rowidApart = (info: TableInfo | undefined): boolean =>
	info !== undefined && !info.withoutRowid && !info.rowidAlias

/** Whether a rowid fits beside `columns` columns in one SELECT on D1 */
const rowidFits = (columns: number): boolean => columns < D1_RESULT_COLUMNS

/** Why a table gets new rowids, as a classification names it */
const renumbered = (table: string, columns: number): string =>
	`${table} gets new rowids (${columns} columns, no INTEGER PRIMARY KEY)`

// per-process-constant: an Atlas copy's head, after any comments: its target and column list, then its SELECT
const COPY_HEAD = /* @__PURE__ */ new RegExp(
	`^((?:\\s|--[^\\n]*(?:\\n|$)|/\\*[\\s\\S]*?\\*/)*INSERT INTO ${QNAME} \\()([^)]*\\) SELECT )`,
	"i",
)

/** The columns an Atlas copy writes */
const copied = (code: string): string[] => splitTopLevel(/\(([^)]*)\)/.exec(code)?.[1] as string)

/**
 * Atlas's copy of `T`, rewritten to carry `T`'s rowids, when `T` has them, the copy keeps them
 * apart from its key, and they fit beside its columns; otherwise undefined
 */
function rowidCopy(
	{ code, stmt }: { code: string; stmt: string },
	{ table, temp }: Rebuild,
	schema: ExtractedSchema,
): string | undefined {
	const from = schema.tableInfo.get(table)
	const fits = rowidFits(copied(code).length)
	if (from === undefined || from.withoutRowid || !rowidApart(schema.tableInfo.get(temp)) || !fits) return undefined
	return stmt.replace(COPY_HEAD, (_, head: string, rest: string) => `${head}rowid, ${rest}rowid, `)
}

/** The tables a rebuild leaves under new rowids, each as the classification names it */
function renumberedBy(
	{ table, temp }: Rebuild,
	schema: ExtractedSchema,
	{ closure, code }: { closure: readonly string[]; code: string },
): string[] {
	const columns = copied(code)
	const carried = lastPart(columns[0] as string).toLowerCase() === "rowid"
	const self = schema.tableInfo.get(table)?.withoutRowid === false && rowidApart(schema.tableInfo.get(temp))
	return [
		...(self && !carried && !rowidFits(columns.length) ? [renumbered(table, columns.length)] : []),
		...closure.flatMap((t) => {
			const width = stored(t, schema).length
			return rowidApart(schema.tableInfo.get(t)) && !rowidFits(width) ? [renumbered(t === temp ? table : t, width)] : []
		}),
	]
}

/**
 * A closure table's columns as the keep table holds them: its rowid first when it carries one
 * apart and it fits; comb 0.8 (`legacy`) carried every rowid table's
 */
function kept(table: string, schema: ExtractedSchema, legacy: boolean): { columns: string[]; rowid: boolean } {
	const columns = stored(table, schema)
	const info = schema.tableInfo.get(table)
	const rowid = legacy ? info?.withoutRowid !== true : rowidApart(info) && rowidFits(columns.length)
	return { columns: columns.map(quote), rowid }
}

export { kept, quote, type Rebuild, renumberedBy, rowidCopy }
