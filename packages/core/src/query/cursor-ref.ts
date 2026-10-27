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
import { CursorRef, effectiveNulls, lossy } from "./cursor.ts"
import { cursorPrecision } from "./cursor-precision.ts"
import { inSeconds } from "./sqlite/cursor-fit.ts"
import { AnchorBound, countLiteral, type SortKey } from "./sqlite/keyset.ts"

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
type Anchor = { id: unknown; nonFinite?: "exact" | undefined; table: object; tiebreak: SQLWrapper }

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

/** An integer as an SQL literal, its sign kept */
const literal = (n: number): SQL => sql`${n < 0 ? sql`-` : sql``}${countLiteral(Math.abs(n))}`

/**
 * A Date on a seconds-mode SQLite timestamp key: the row's own value while it still lies in the
 * cursor's millisecond, whose fraction below it no Date holds (U10). A Date truncates toward zero,
 * as `CAST(… AS INTEGER)` does, so that is the row whose value times 1000 truncates to the Date's
 * milliseconds. Otherwise (the row edited since, an updated_at bump among them, or gone, its id
 * perhaps given out again) the edge of that millisecond toward the rows already served, so a row of
 * it may come again and none is skipped (U20): the millisecond is [ms, ms + 1) after 1970, (ms - 1,
 * ms] before it, and (-1, 1) at 0. The milliseconds are literals, so the bound costs the id alone.
 */
function secondsBound({ column, direction }: SortKey, value: Date, at: Anchor): SQL {
	const truncated = value.getTime()
	/* each edge widened on its own: a Date of 0 is any stored value within a millisecond either side of it */
	const [low, high] = [truncated > 0 ? truncated : truncated - 1, truncated < 0 ? truncated : truncated + 1]
	const ms = direction === "asc" ? low : high
	const fallback = sql`(${literal(ms)} / 1000.0)`
	const kept = sql`CASE WHEN CAST(${column} * 1000 AS INTEGER) = ${literal(truncated)} THEN ${column} END`
	return sql`coalesce((SELECT ${kept} FROM ${fromOf(at.table)} WHERE ${at.tiebreak} = ${at.id}), ${fallback})`
}

/** Whether `column` is a Postgres `timestamp` read in date mode, which reads 'infinity' and '-infinity' as one valid Date */
const misreadsInfinity = (column: SQLWrapper): boolean => {
	const { columnType, withTimezone } = column as { columnType?: unknown; withTimezone?: unknown }
	return columnType === "PgTimestamp" && withTimezone !== true
}

/* the Date node-postgres reads a `timestamp` 'infinity' and '-infinity' as: 2000-01-01, local midnight */
const misreadInfinity = (value: Date): boolean => value.getTime() === new Date(2000, 0, 1).getTime()

/**
 * The Date node-postgres gives both infinities, on a date-mode Postgres `timestamp` key: the row's
 * own value while it is infinite, at the precision the order compares it (U17); the Date itself
 * while the row still holds it, as a row of local 2000-01-01 does (U20). Once the row is gone, or
 * edited to another finite value, it may have held either infinity, so the list resumes from the
 * direction's own end, repeating rows and skipping none. Every other Date is bound as it is; a driver
 * that reads infinity as an Invalid Date is bounded by unheldBound.
 */
function timestampBound({ column, direction }: SortKey, value: Date, at: Anchor): SQL {
	const end = direction === "asc" ? sql`'-infinity'::timestamp` : sql`'infinity'::timestamp`
	const date = sql.param(value, column as never)
	/* an infinite row is its own bound; a finite one only while it is still that Date (a row of local
	   2000-01-01); one edited since, an infinite one made finite among them, bounds as a deleted row */
	const kept = sql`CASE WHEN NOT isfinite(${column}) THEN ${column} WHEN ${cursorPrecision(column)} = ${date} THEN ${column} END`
	return sql`coalesce((SELECT ${kept} FROM ${fromOf(at.table)} WHERE ${at.tiebreak} = ${at.id}), ${end})`
}

/**
 * A Date on a Postgres timestamp finer than the millisecond its cursor keeps: the row's exact value
 * while it truncates to that millisecond, else the millisecond's edge toward the rows already
 * served, its start ascending and its end descending, so a row of it may come again and none is
 * skipped. The key is ordered and sought as the column itself, so an index on it and the id
 * serves the page (U27), as SQLite seconds are bounded (U20).
 */
function millisecondBound({ column, direction }: SortKey, value: Date, at: Anchor): SQL {
	const date = sql.param(value, column as never)
	const type = (column as { withTimezone?: unknown }).withTimezone === true ? sql`timestamptz` : sql`timestamp`
	const edge =
		direction === "asc" ? sql`CAST(${date} AS ${type})` : sql`(CAST(${date} AS ${type}) + interval '1 millisecond')`
	const kept = sql`CASE WHEN ${cursorPrecision(column)} = ${date} THEN ${column} END`
	return sql`coalesce((SELECT ${kept} FROM ${fromOf(at.table)} WHERE ${at.tiebreak} = ${at.id}), ${edge})`
}

/**
 * `'-infinity'` or `'infinity'` as `column`'s own Postgres type: a `date`, else a `timestamptz`, the
 * two that read an infinity as an Invalid Date (a `timestamp` reads it as 2000-01-01, U17)
 */
function pgInfinity(column: SQLWrapper, sign: "-" | "+"): SQL {
	const word = sign === "-" ? sql`'-infinity'` : sql`'infinity'`
	return (column as { columnType?: unknown }).columnType === "PgDate" ? sql`${word}::date` : sql`${word}::timestamptz`
}

/**
 * A Date no JS Date holds, which a date-mode Postgres `timestamptz` or `date` holding ±infinity
 * reads as, and so does a SQLite timestamp holding ±Infinity on bun:sqlite and libsql (3.24): the
 * row's own value while it is infinite, exact as the order compares it. Once the row is gone, or
 * finite, it may have held either infinity, so the list resumes from the direction's own end,
 * repeating rows and skipping none, as a date-mode `timestamp` does (U17).
 */
function unheldBound({ column, direction }: SortKey, at: Anchor): SQL {
	const sqlite = is(column, SQLiteColumn)
	const infinite = sqlite ? sql`${column} IN (9e999, -9e999)` : sql`NOT isfinite(${column})`
	const sign = direction === "asc" ? "-" : "+"
	const end = sqlite ? (sign === "-" ? sql`-9e999` : sql`9e999`) : pgInfinity(column, sign)
	return sql`coalesce((SELECT CASE WHEN ${infinite} THEN ${column} END FROM ${fromOf(at.table)} WHERE ${at.tiebreak} = ${at.id}), ${end})`
}

/** Whether `column` is a SQLite number, which D1 may hand over as null when it holds ±Infinity */
const holdsInfinity = (column: SQLWrapper) =>
	is(column, SQLiteColumn) && (column.dataType.startsWith("number") || column.dataType === "object date")

/**
 * A null on a SQLite number key: the row's own value where it is ±Infinity, NULL where it is NULL.
 * Once the row is gone, on a driver that reads ±Infinity as null (D1) the null may have been any
 * of the three, so it is the earliest of them in the order (U24): NULL where NULLs come first,
 * else -Infinity ascending and +Infinity descending, which repeats rows and skips none. With
 * `nonFinite: "exact"` the driver reads them back, so a null is a real NULL and stays one. One
 * aggregate over the row tells a gone row from a NULL one.
 */
function infiniteBound({ column, direction, nulls }: SortKey, at: Anchor): SQL {
	const earliest = effectiveNulls(direction, nulls) === "first" || at.nonFinite === "exact"
	const gone = earliest ? sql`NULL` : direction === "asc" ? sql`-9e999` : sql`9e999`
	return sql`(SELECT CASE WHEN count(*) = 0 THEN ${gone} WHEN max(${column}) IN (9e999, -9e999) THEN max(${column}) END FROM ${fromOf(at.table)} WHERE ${at.tiebreak} = ${at.id})`
}

/** A rounded integer key: the row's own exact value, the cursor's once the row is gone */
const exactBound = ({ column }: SortKey, value: number, at: Anchor): SQL =>
	sql`coalesce((SELECT ${column} FROM ${fromOf(at.table)} WHERE ${at.tiebreak} = ${at.id}), ${value})`

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
 * `tiebreak`: a reference, a Date on a seconds-mode timestamp key, a null on a SQLite number key, and an
 * integer a JS number rounds
 */
function anchored(keys: readonly SortKey[], values: readonly unknown[], at: Anchor): unknown[] {
	return values.map((value, i) => {
		const key = keys[i] as SortKey
		if (value instanceof CursorRef)
			return new AnchorBound("row", textBound(key, value, at), !is(key.column, SQLiteColumn))
		if (value instanceof Date && Number.isNaN(value.getTime())) return new AnchorBound("row", unheldBound(key, at))
		if (value instanceof Date && inSeconds(key.column)) return new AnchorBound("row", secondsBound(key, value, at))
		if (value instanceof Date && misreadsInfinity(key.column) && misreadInfinity(value))
			return new AnchorBound("row", timestampBound(key, value, at))
		if (value instanceof Date && cursorPrecision(key.column) !== key.column)
			return new AnchorBound("row", millisecondBound(key, value, at))
		if (lossy(value)) return new AnchorBound("row", exactBound(key, value, at))
		return value === null && holdsInfinity(key.column) ? new AnchorBound("infinite", infiniteBound(key, at)) : value
	})
}

export { anchored, assertNoReference, fromOf }
