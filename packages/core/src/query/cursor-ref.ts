/**
 * A sort key too long for a cursor (R8). Any client can write a long title, and a cursor carries
 * every sort value, so the cursor at that row would pass MAX_CURSOR_LENGTH and the next page would
 * refuse it. Such a value is carried by reference instead: the cursor holds the row's id (it always
 * does), the longest prefix of the value that fits and the value's length, both in code points, and
 * the keyset reads the value from the row while the row still has that prefix and length:
 *
 *   (SELECT CASE WHEN substr(t.key, 1, L) = p.v AND length(t.key) = N THEN t.key ELSE fallback END
 *    FROM (SELECT ? AS v) AS p LEFT JOIN t ON t.id = ?)
 *
 * Exact while the row is there unchanged. An edit that keeps both the prefix and the length still
 * moves the bound to the new value; any other edit, or a delete, resumes from the fallback: the
 * prefix itself ascending and the prefix followed by U+10FFFF descending. Under binary, NOCASE and C
 * collation the first sorts at or before the value and the second at or after it, so resuming
 * there may repeat rows that share the prefix and skips none. Postgres takes the fallback only on a
 * C or POSIX collation; under any other, neither bound is safe, the bound is NULL, and the list
 * ends there. A derived list has no table to read from, so its overflowing cursor is refused when
 * it is minted.
 *
 * D1 hands a REAL ±Infinity over as null (its transport is JSON), so a cursor minted from such a
 * row carries null. On a SQLite number key a null is read back from the row, ±Infinity only:
 *
 *   (SELECT CASE WHEN t.key IN (9e999, -9e999) THEN t.key END FROM t WHERE t.id = ?)
 *
 * which is NULL whenever the row holds anything else or is gone, the null the cursor carried. A
 * deleted ±Infinity anchor so resumes from the NULLs' place.
 */
import { getTableName, is, type SQL, type SQLWrapper, sql, type Table } from "drizzle-orm"
import { SQLiteColumn } from "drizzle-orm/sqlite-core"

import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import { createCursor, CursorRef, MAX_CURSOR_LENGTH } from "./cursor.ts"
import type { CursorOptions } from "./cursor-seal.ts"
import { cursorPrecision } from "./cursor-precision.ts"
import { inSeconds } from "./sqlite/cursor-fit.ts"
import { AnchorBound, countLiteral, type SortKey } from "./sqlite/keyset.ts"
import type { SortField } from "./types.ts"

/** paginate's choice for an overflowing key: by reference on a table, refused on a derived list */
type KeysetKind = "derived" | "table"

const codePoints = (text: string): string[] => Array.from(text)

/** `record[field]` by reference: its longest prefix whose cursor fits, given the other values, cut on a code point; undefined when none does */
function longestFitting(record: Record<string, unknown>, field: string, fits: (r: Record<string, unknown>) => boolean) {
	const points = codePoints(record[field] as string)
	const ref = (n: number) => new CursorRef(points.slice(0, n).join(""), points.length)
	let [low, high] = [0, points.length]
	if (!fits({ ...record, [field]: ref(0) })) return undefined
	while (low < high) {
		const mid = Math.ceil((low + high) / 2)
		if (fits({ ...record, [field]: ref(mid) })) low = mid
		else high = mid - 1
	}
	return ref(low)
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
		const ref = longestFitting(record, field, fits)
		record = { ...record, [field]: ref ?? new CursorRef("", codePoints(row[field] as string).length) }
		if (ref !== undefined) return mint(record)
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

/** Whether `column` sorts by code point on Postgres: C or POSIX, its own or the database's default */
const byCodePoint = (column: SQLWrapper) =>
	sql`(pg_collation_for(${column}) IN ('"C"', '"POSIX"') OR (pg_collation_for(${column}) = '"default"' AND (SELECT datcollate FROM pg_database WHERE datname = current_database()) IN ('C', 'POSIX')))`

/** Where the keyset reads the cursor's row: the table, the tiebreak column and the row's id */
type Anchor = { id: unknown; table: object; tiebreak: SQLWrapper }

/**
 * The bound a reference compares with: the row's value while it has the reference's prefix and
 * length, in code points, else the prefix bound where it is safe (NULL where it is not). The prefix
 * is bound once, so the bound costs two parameters, and one for an empty prefix.
 */
function textBound(key: SortKey, ref: CursorRef, at: Anchor): SQL {
	const { column, direction } = key
	const sqlite = is(column, SQLiteColumn)
	const cut = countLiteral(Array.from(ref.prefix).length)
	const head = sqlite ? sql`substr(${column}, 1, ${cut})` : sql`left(${column}, ${cut})`
	const size = sqlite ? sql`length(${column})` : sql`char_length(${column})`
	const prefix = ref.prefix === "" ? sql`''` : sql`${ref.prefix}`
	const above =
		direction === "asc"
			? sql`comb_anchor.v`
			: sql`(comb_anchor.v || ${sqlite ? sql`char(1114111)` : sql`chr(1114111)`})`
	const fallback = sqlite ? above : sql`CASE WHEN ${byCodePoint(column)} THEN ${above} END`
	return sql`(SELECT CASE WHEN ${head} = comb_anchor.v AND ${size} = ${countLiteral(ref.length)} THEN ${column} ELSE ${fallback} END FROM (SELECT ${prefix} AS v) AS comb_anchor LEFT JOIN ${fromOf(at.table)} ON ${at.tiebreak} = ${at.id})`
}

/**
 * A Date on a seconds-mode SQLite timestamp key: the row's own value, whose fraction below a
 * millisecond no Date holds (U10); once the row is gone, the edge of the millisecond the stored value
 * lay in toward the rows already served, so a row of that millisecond may come again and none is
 * skipped. A Date truncates toward zero, so that millisecond is [ms, ms + 1) after 1970, (ms - 1,
 * ms] before it, and (-1, 1) at 0. The milliseconds are literals, so the bound costs the id alone.
 */
function secondsBound({ column, direction }: SortKey, value: Date, at: Anchor): SQL {
	const truncated = value.getTime()
	/* each edge widened on its own: a Date of 0 is any stored value within a millisecond either side of it */
	const [low, high] = [truncated > 0 ? truncated : truncated - 1, truncated < 0 ? truncated : truncated + 1]
	const ms = direction === "asc" ? low : high
	const fallback = sql`(${ms < 0 ? sql`-` : sql``}${countLiteral(Math.abs(ms))} / 1000.0)`
	return sql`coalesce((SELECT ${column} FROM ${fromOf(at.table)} WHERE ${at.tiebreak} = ${at.id}), ${fallback})`
}

/** Whether `column` is a Postgres `timestamp` read in date mode, which reads 'infinity' and '-infinity' as one valid Date */
const misreadsInfinity = (column: SQLWrapper): boolean => {
	const { columnType, withTimezone } = column as { columnType?: unknown; withTimezone?: unknown }
	return columnType === "PgTimestamp" && withTimezone !== true
}

/**
 * A Date on a date-mode Postgres `timestamp` key: the row's own value, at the precision the order
 * compares it (U17), as the engine holds an 'infinity' node-postgres reads as 2000-01-01, local
 * midnight, for 'infinity' and '-infinity' alike. Once the row is gone, the Date itself, unless it is
 * that one: the row may have held either infinity, so the list resumes from the direction's own end,
 * repeating rows and skipping none. A driver that reads infinity as an Invalid Date mints no cursor.
 */
function timestampBound({ column, direction }: SortKey, value: Date, at: Anchor): SQL {
	const fallback =
		value.getTime() === new Date(2000, 0, 1).getTime()
			? direction === "asc"
				? sql`'-infinity'::timestamp`
				: sql`'infinity'::timestamp`
			: sql.param(value, column as never)
	return sql`coalesce((SELECT ${cursorPrecision(column)} FROM ${fromOf(at.table)} WHERE ${at.tiebreak} = ${at.id}), ${fallback})`
}

/** Whether `column` is a SQLite number, which D1 may hand over as null when it holds ±Infinity */
const holdsInfinity = (column: SQLWrapper) =>
	is(column, SQLiteColumn) && (column.dataType.startsWith("number") || column.dataType === "object date")

/** A null on a SQLite number key: the row's own value where it is ±Infinity, NULL otherwise or once the row is gone */
const infiniteBound = ({ column }: SortKey, at: Anchor): SQL =>
	sql`(SELECT CASE WHEN ${column} IN (9e999, -9e999) THEN ${column} END FROM ${fromOf(at.table)} WHERE ${at.tiebreak} = ${at.id})`

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

/**
 * The cursor's values with each one the row must supply read from `table`, the row keyed `id` by
 * `tiebreak`: a reference, a Date on a seconds-mode timestamp key, and a null on a SQLite number key
 */
function anchored(keys: readonly SortKey[], values: readonly unknown[], at: Anchor): unknown[] {
	return values.map((value, i) => {
		const key = keys[i] as SortKey
		if (value instanceof CursorRef)
			return new AnchorBound("row", textBound(key, value, at), !is(key.column, SQLiteColumn))
		if (value instanceof Date && inSeconds(key.column)) return new AnchorBound("row", secondsBound(key, value, at))
		if (value instanceof Date && misreadsInfinity(key.column))
			return new AnchorBound("row", timestampBound(key, value, at))
		return value === null && holdsInfinity(key.column) ? new AnchorBound("infinite", infiniteBound(key, at)) : value
	})
}

export { anchored, assertNoReference, fromOf, type KeysetKind, mintWithin }
