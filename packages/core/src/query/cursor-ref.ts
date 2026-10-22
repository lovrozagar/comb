/**
 * A sort key too long for a cursor (R8). Any client can write a long title, and a cursor carries
 * every sort value, so the cursor at that row would pass MAX_CURSOR_LENGTH and the next page would
 * refuse it. Such a value is carried by reference instead: the cursor holds the row's id (it always
 * does) and the longest prefix of the value that fits, and the keyset reads the value from the row:
 *
 *   COALESCE((SELECT key FROM t WHERE id = ?), fallback)
 *
 * Exact while the row is there. Once it is deleted the fallback is the prefix itself ascending and
 * the prefix followed by U+10FFFF descending: under binary, NOCASE and C collation the first sorts
 * at or before the value and the second at or after it, so resuming there may repeat rows that
 * share the prefix and skips none. Postgres takes the fallback only on a C or POSIX collation; under
 * any other, neither bound is safe, and a deleted anchor ends the list. A derived list has no table
 * to read from, so its overflowing cursor is refused when it is minted.
 */
import { getTableName, is, type SQL, type SQLWrapper, sql, type Table } from "drizzle-orm"
import { SQLiteColumn } from "drizzle-orm/sqlite-core"

import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import { createCursor, CursorRef, MAX_CURSOR_LENGTH } from "./cursor.ts"
import type { CursorOptions } from "./cursor-seal.ts"
import type { SortKey } from "./sqlite/keyset.ts"
import type { SortField } from "./types.ts"

/** paginate's choice for an overflowing key: by reference on a table, refused on a derived list */
type KeysetKind = "derived" | "table"

const codePoints = (text: string): string[] => Array.from(text)

/** The longest prefix of `record[field]` whose cursor fits, given the other values; undefined when none does */
function longestFitting(record: Record<string, unknown>, field: string, fits: (r: Record<string, unknown>) => boolean) {
	const points = codePoints(record[field] as string)
	let [low, high] = [0, points.length]
	if (!fits({ ...record, [field]: new CursorRef("") })) return undefined
	while (low < high) {
		const mid = Math.ceil((low + high) / 2)
		if (fits({ ...record, [field]: new CursorRef(points.slice(0, mid).join("")) })) low = mid
		else high = mid - 1
	}
	return points.slice(0, low).join("")
}

/** The overflow, as paginate reports it on the page that met it: a 500 naming the field and the cap */
function tooLong(fields: string, length: number, kind: KeysetKind): CombError {
	const reason =
		kind === "derived"
			? "a derived list reads no row to page by reference, so sort it by a key of bounded length"
			: "even carried by reference, the other keys leave no room; sort by fewer long keys"
	return new CombError({
		cause: `a row's ${fields} is too long to page this list by: its cursor would be ${length} characters, past ${MAX_CURSOR_LENGTH}; ${reason}`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})
}

/**
 * The cursor for `row`, its longest string values carried by reference while it passes the cap;
 * a 500 on a derived list, or when no reference makes it fit
 */
function mintWithin(
	row: Record<string, unknown>,
	sort: readonly SortField[],
	options: CursorOptions & { idField?: string | undefined; keyset?: KeysetKind | undefined },
): string {
	const mint = (record: Record<string, unknown>) => createCursor(record, sort, options)
	const fits = (record: Record<string, unknown>) => mint(record).length <= MAX_CURSOR_LENGTH
	const whole = mint(row)
	if (whole.length <= MAX_CURSOR_LENGTH) return whole
	const fields = sort.map(({ field }) => field).join(", ")
	if (options.keyset === "derived") throw tooLong(fields, whole.length, "derived")
	const long = sort
		.map(({ field }) => field)
		.filter((field) => typeof row[field] === "string")
		.sort((a, b) => (row[b] as string).length - (row[a] as string).length)
	let record = row
	for (const field of long) {
		const prefix = longestFitting(record, field, fits)
		record = { ...record, [field]: new CursorRef(prefix ?? "") }
		if (prefix !== undefined) return mint(record)
	}
	throw tooLong(fields, whole.length, "table")
}

/* drizzle's own keys for a table's name before any alias, and its schema */
const ORIGINAL_NAME = /* @__PURE__ */ Symbol.for("drizzle:OriginalName")
const SCHEMA = /* @__PURE__ */ Symbol.for("drizzle:Schema")

/** `table` as a FROM item: its own name, with the alias a relational query gave it reapplied */
function fromOf(table: object): SQL {
	const original = (table as Record<symbol, string>)[ORIGINAL_NAME] as string
	const schema = (table as Record<symbol, string | undefined>)[SCHEMA]
	const qualified = schema
		? sql`${sql.identifier(schema)}.${sql.identifier(original)}`
		: sql`${sql.identifier(original)}`
	const name = getTableName(table as Table)
	return name === original ? qualified : sql`${qualified} AS ${sql.identifier(name)}`
}

/* the largest code point: a prefix followed by it sorts at or after every value with that prefix */
const LAST = "\u{10FFFF}"

/** Whether `column` sorts by code point on Postgres: C or POSIX, its own or the database's default */
const byCodePoint = (column: SQLWrapper) =>
	sql`(pg_collation_for(${column}) IN ('"C"', '"POSIX"') OR (pg_collation_for(${column}) = '"default"' AND (SELECT datcollate FROM pg_database WHERE datname = current_database()) IN ('C', 'POSIX')))`

/** The bound a reference compares with: the row's own value, else the prefix bound where it is safe */
function anchorBound(key: SortKey, ref: CursorRef, source: SQL): SQL {
	const fallback = key.direction === "asc" ? ref.prefix : `${ref.prefix}${LAST}`
	if (is(key.column, SQLiteColumn)) return sql`COALESCE(${source}, ${fallback})`
	return sql`COALESCE(${source}, CASE WHEN ${byCodePoint(key.column)} THEN ${fallback} END)`
}

/** A 500 when a list with no table to read from got a reference: paginate was not told the list is derived */
function assertNoReference(values: readonly unknown[]): void {
	if (!values.some((value) => value instanceof CursorRef)) return
	throw new CombError({
		cause:
			"paginate minted this cursor by reference, which a derived list cannot read; pass { keyset: 'derived' } to paginate",
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})
}

/** The cursor's values with each reference resolved against `table`, the row keyed `id` by `tiebreak` */
function anchored(
	keys: readonly SortKey[],
	values: readonly unknown[],
	at: { id: unknown; table: object; tiebreak: SQLWrapper },
): unknown[] {
	return values.map((value, i) => {
		if (!(value instanceof CursorRef)) return value
		const key = keys[i] as SortKey
		const source = sql`(SELECT ${key.column} FROM ${fromOf(at.table)} WHERE ${at.tiebreak} = ${at.id})`
		return anchorBound(key, value, source)
	})
}

export { anchored, assertNoReference, fromOf, type KeysetKind, mintWithin }
