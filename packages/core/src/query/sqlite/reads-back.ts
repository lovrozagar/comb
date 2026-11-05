/**
 * Whether a list's key reads its bound back from the anchor row, by the tables drizzle tells apart: the
 * rule a reference is minted and read by (27.7 of plan 15), and a key bound as read where it fails.
 */
import { Column, is, SQL, type SQLWrapper, Table } from "drizzle-orm"

import { holdsText } from "./timestamp-column.ts"

/** Every column `chunk` reads, through the SQL it nests */
function columnsOf(chunk: unknown): Column[] {
	if (is(chunk, Column)) return [chunk]
	if (is(chunk, SQL)) return chunk.queryChunks.flatMap(columnsOf)
	return Array.isArray(chunk) ? chunk.flatMap(columnsOf) : []
}

/* drizzle keeps the table a column is of on it, untyped */
const tableOf = (column: Column): unknown => (column as unknown as { table: unknown }).table

/* the names drizzle tells one table from another by: an alias's own name over its table's, and its schema */
const NAME = /* @__PURE__ */ Symbol.for("drizzle:Name")
const ORIGINAL_NAME = /* @__PURE__ */ Symbol.for("drizzle:OriginalName")
const SCHEMA = /* @__PURE__ */ Symbol.for("drizzle:Schema")

/** A table's name, its original table's and its schema, as drizzle keys a table in a query */
const tableKey = (table: Table): unknown[] => {
	const named = table as unknown as Record<symbol, unknown>
	return [named[NAME], named[ORIGINAL_NAME], named[SCHEMA]]
}

/**
 * Whether `a` and `b` are one table as a query reads it: one object, or two of drizzle's for the same
 * name, original table and schema. An alias's columns carry a table of their own, which is no alias
 * object, so identity alone refused an anchor that is an alias (27.19 of plan 15); another alias of
 * the same table has another name, and stays apart.
 */
function sameTable(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (!is(a, Table) || !is(b, Table)) return false
	const [x, y] = [tableKey(a), tableKey(b)]
	return x.every((part, i) => part === y[i])
}

/**
 * Whether the anchor row `table` supplies the key `column`, so the keyset may read a bound from that
 * row: a column of that table does, and so does an SQL expression over that table's own columns
 * alone, which the read evaluates on that row (27.7 of plan 15). A joined table's column, or an
 * expression over one, reads the anchor's own value back through a subquery that correlates to each
 * candidate row, which skipped and looped rows for every bound read from the row (QL1 of r22b; 27.14
 * guarded only text), so such a key binds as an anchorless list binds it. With no anchor in reach, as
 * on the relational path, a column reads back: there every key is the queried table's own column, as
 * keysOn (query/drizzle.ts:57-68) takes each sort field as an own property of that table and refuses
 * any other, so no relation column through `with`, nor an extras SQL, becomes a key.
 */
function readsBack(column: SQLWrapper, table: object | undefined): boolean {
	if (is(column, Column)) return table === undefined || sameTable(tableOf(column), table)
	if (!is(column, SQL) || table === undefined) return false
	const read = columnsOf(column)
	return read.length > 0 && read.every((each) => sameTable(tableOf(each), table))
}

/**
 * Whether a cursor value carried by reference on `column` reads back from `table`'s row: a key the row
 * supplies (readsBack) whose column, if it is one, holds text. The mint and the read both ask it, so
 * no list mints a cursor it then refuses.
 */
const refersBack = (column: SQLWrapper, table: object | undefined): boolean =>
	readsBack(column, table) && (!is(column, Column) || column.dataType.startsWith("string") || holdsText(column))

export { readsBack, refersBack }
