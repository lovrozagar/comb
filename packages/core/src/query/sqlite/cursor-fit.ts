/**
 * A cursor is client input: its values reach the keyset predicate as bound parameters, so each one
 * must be what its column holds. A real row encodes exactly that; anything else is a forged or
 * stale cursor, answered with a 400 before drizzle maps it (a string on a timestamp column would
 * otherwise throw a TypeError, a 500).
 */
import { Column, type ColumnDataType, is, SQL, type SQLWrapper, sql, Table } from "drizzle-orm"
import { SQLiteColumn } from "drizzle-orm/sqlite-core"

import { CombError } from "../../error.ts"
import { CursorRef } from "../cursor.ts"
import { combErrorKeys } from "../../types.ts"
import type { ListDialect } from "../list-dialect.ts"
import { INTEGER_TEXT } from "../list-extras.ts"
import { carriedStored, carriedText, holdsText, inSeconds } from "./timestamp-column.ts"

/**
 * What a column of each drizzle `dataType` family holds, given its full `dataType`. Keyed by drizzle's
 * own family union, so a family drizzle adds is a type error here rather than a cursor every column of
 * it refuses (AB2 of area B). A json column holds nothing a cursor carries, nor an array one; a
 * buffer-mode blob its bytes (QL5 of r22b). A number column holds a bigint too where the driver returns
 * integers as one (libsql's intMode "bigint", bun:sqlite's safeIntegers), or as a decimal string
 * (libsql's intMode "string", Q2 of r19), and a cursor minted from its row carries it. A SQLite
 * `numeric()` column reads every value as a string, but a list that binds it as read carries a value
 * as SQLite stored it, an integer as a bigint and a REAL as its double (B2-4 of area B), which NUMERIC
 * affinity compares as the number it is, so it holds those too. A `customType`
 * column holds whatever its `fromDriver` read, opaque to comb: any value a cursor carries, bound back
 * through its `toDriver`.
 */
const HOLDS: Record<ColumnDataType, (value: unknown, dataType: string) => boolean> = {
	array: () => false,
	bigint: (value) => typeof value === "bigint",
	boolean: (value) => typeof value === "boolean",
	custom: (value) =>
		["bigint", "boolean", "number", "string"].includes(typeof value) ||
		value instanceof Date ||
		value instanceof Uint8Array,
	number: (value) =>
		typeof value === "number" || typeof value === "bigint" || (typeof value === "string" && INTEGER_TEXT.test(value)),
	object: (value, dataType) =>
		(dataType === "object date" && value instanceof Date) ||
		(dataType === "object buffer" && value instanceof Uint8Array),
	string: (value, dataType) =>
		typeof value === "string" ||
		(dataType === "string numeric" && (typeof value === "bigint" || typeof value === "number")),
}

/** Whether `value` is what a column of this drizzle `dataType` holds (HOLDS) */
const fitsDataType = (dataType: string, value: unknown): boolean =>
	HOLDS[dataType.split(" ")[0] as ColumnDataType]?.(value, dataType) ?? false

/**
 * A derived sort key declared as time: its expression yields epoch milliseconds, and its cursor
 * value is a Date, bound as that number, or the number itself when the row selected it as one
 */
class DateKey implements SQLWrapper {
	readonly expression: SQLWrapper

	constructor(expression: SQLWrapper) {
		this.expression = expression
	}

	getSQL(): SQL {
		return this.expression.getSQL()
	}
}

const isInteger = (value: unknown) =>
	typeof value === "bigint" ||
	(typeof value === "number" && Number.isFinite(value)) ||
	(typeof value === "string" && INTEGER_TEXT.test(value))

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

/**
 * Whether `value` is a time key's stored value as a list that binds the key as read carries it (QL2
 * of r22b): a Postgres date-mode column's text, or a SQLite timestamp's stored seconds or milliseconds
 */
const carriedTime = (column: SQLWrapper, value: unknown): boolean =>
	is(column, SQLiteColumn)
		? holdsText(column) && typeof value === "number"
		: is(column, Column) && column.dataType === "object date" && typeof value === "string"

/**
 * Null fits every key. A column takes what its dataType holds, and a time column bound as read
 * (`asRead`) its stored value too (carriedTime); a key declared as time, a Date or the epoch
 * milliseconds its row selected; any other SQL expression (a derived sort) only what every driver
 * binds: a string, a number, a bigint, a boolean or bytes (bun:sqlite and D1 refuse a Date that libsql
 * would bind); a value carried by reference, a key that reads it back (refersBack); and a SQLite timestamp's
 * TEXT or a boolean's value but 0 or 1 that a list reading it back carried (`carried`), as the row held it (B2-3, AB3-2 of area B)
 */
function fits(
	column: SQLWrapper,
	value: unknown,
	{ asRead, carried, table }: { asRead: boolean; carried: boolean; table: object | undefined },
): boolean {
	if (value === null) return true
	if (value instanceof CursorRef) return refersBack(column, table)
	if (column instanceof DateKey) return value instanceof Date || isInteger(value)
	if (asRead && carriedTime(column, value)) return true
	if (readsRounded(column) && typeof value === "string") return NUMERIC_TEXT.test(value)
	if (carriedText(column, value, { asRead, carried }) || carriedStored(column, value, { asRead, carried })) return true
	if (is(column, Column)) return fitsDataType(column.dataType, value)
	return ["string", "number", "boolean", "bigint"].includes(typeof value) || value instanceof Uint8Array
}

/**
 * A cursor value as every SQLite driver binds it: a bigint a number holds exactly as that number
 * (D1 binds no bigint), and ±Infinity as the literal SQLite reads as it (libsql binds no Infinity;
 * SQLite stores NaN as NULL, so no SQLite row holds one)
 */
function bindable(value: unknown): unknown {
	if (typeof value === "number" && Number.isFinite(value) === false && !Number.isNaN(value))
		return value > 0 ? sql`9e999` : sql`-9e999`
	return typeof value === "bigint" && Number.isSafeInteger(Number(value)) ? Number(value) : value
}

/**
 * Whether `column` reads its stored number rounded: a Postgres numeric in drizzle's number mode, whose
 * read is the nearest double (QL3 of r22b), so every list carries its text (`_combKeyTexts`) and a
 * cursor binds that. A SQLite numeric stores an INTEGER or a REAL, which its driver reads as stored
 */
const readsRounded = (column: SQLWrapper | undefined): boolean =>
	is(column, Column) && column.dataType === "number" && !is(column, SQLiteColumn)

/* the text Postgres prints a numeric as */
const NUMERIC_TEXT = /^(?:-?\d+(?:\.\d+)?|NaN|-?Infinity)$/

/**
 * Whether `column` is a Postgres `customType` column, which carries its text where Postgres's own type
 * of it is a numeric (AB2 of area B), as an expression key does: its mapper may read one as a number.
 * Carried, the text binds as itself, typed as the column; as read, a value goes through its `toDriver`
 */
const carriesOpaque = (column: SQLWrapper | undefined): boolean =>
	is(column, Column) && column.dataType === "custom" && !is(column, SQLiteColumn)

/**
 * A cursor value as its key binds it. Stored text the list carried (`carried`, the cursor's flag)
 * binds as itself, past the column's mapper: cast to numeric on a key that reads rounded, and on a
 * Postgres custom column as a parameter Postgres types as the column it is compared with, its own type. A value as read binds through the mapper, so a custom
 * column's `toDriver` writes it as it writes the column (comb-9d's AB2 ruling), a text value that looks
 * like a number included; a cursor with no flag, as every released comb minted, holds only those
 */
function boundCarried(column: SQLWrapper | undefined, value: unknown, carried: boolean): unknown {
	if (carriedText(column, value, { asRead: false, carried })) return sql`${value}`
	/* a boolean's mapper binds any value as 0 or 1; D1 binds no bigint, so one past 2^53 goes as its digits */
	if (carriedStored(column, value, { asRead: false, carried }))
		return typeof value === "bigint" && !Number.isSafeInteger(Number(value))
			? sql`cast(${String(value)} as integer)`
			: sql`${bindable(value)}`
	if (!carried || typeof value !== "string" || !NUMERIC_TEXT.test(value)) return value
	if (readsRounded(column)) return sql`${value}::numeric`
	return carriesOpaque(column) ? sql`${value}` : value
}

/**
 * A Date on a seconds-mode timestamp key as the seconds it holds, to the millisecond (U10): drizzle
 * would floor it to the second. A key the keyset can read from its row reads it there instead
 * (cursor-ref.ts), as a stored fraction below a millisecond is one no Date holds.
 */
const exactSeconds = (value: Date): SQL => sql`${value.getTime() / 1000}`

/**
 * A cursor value as a key bound as read takes it: a Date on a seconds-mode timestamp as its seconds
 * to the millisecond; a time key's carried stored value as itself, past the column's Date mapper,
 * Postgres reading the text as the key's own type (QL2 of r22b)
 */
function boundAsRead(column: SQLWrapper | undefined, value: unknown): unknown {
	if (value instanceof Date) return inSeconds(column) ? exactSeconds(value) : value
	const time = is(column, Column) && column.dataType === "object date"
	return time && (typeof value === "string" || typeof value === "number") ? sql`${value}` : value
}

/**
 * A cursor value as a SQLite key binds it: an integer a number column's or a time key's driver read
 * as a decimal string as that integer, exact (Q2 of r19), which SQLite would otherwise compare as text
 */
const bindableAs = (column: SQLWrapper | undefined, value: unknown): unknown =>
	bindable(
		(column instanceof DateKey || (is(column, Column) && column.dataType.startsWith("number"))) &&
			typeof value === "string" &&
			INTEGER_TEXT.test(value)
			? BigInt(value)
			: value,
	)

/**
 * A cursor value as a key of a `dialect` list binds it: SQLite's way on SQLite (bindableAs), itself on
 * Postgres, whose own cast reads the 'Infinity' its driver writes (QL4 of r22b)
 */
const bindableIn = (dialect: ListDialect, column: SQLWrapper | undefined, value: unknown): unknown =>
	dialect === "sqlite" ? bindableAs(column, value) : value

/**
 * The cursor's values as the keys of a `dialect` list bind them: a Date on a key declared as time as
 * its epoch milliseconds, any other as bindableIn binds it
 */
const boundForKeys = (dialect: ListDialect, columns: readonly SQLWrapper[], values: readonly unknown[]): unknown[] =>
	values.map((value, i) =>
		columns[i] instanceof DateKey && value instanceof Date ? value.getTime() : bindableIn(dialect, columns[i], value),
	)

/**
 * Throw a 400 unless every cursor value, the tiebreak id last, fits its column, a reference read back
 * from `at.table`; `at.asRead` says which keys bind as read, where a time key may carry its stored value,
 * and `at.carried` which the cursor flags as the stored text the list carried
 */
function assertCursorFits(
	columns: readonly SQLWrapper[],
	values: readonly unknown[],
	at: {
		asRead?: ((index: number) => boolean) | undefined
		carried?: ((index: number) => boolean) | undefined
		table?: object | undefined
	} = {},
): void {
	const { asRead = () => false, carried = () => false, table } = at
	const each = (column: SQLWrapper, index: number) =>
		fits(column, values[index], { asRead: asRead(index), carried: carried(index), table })
	if (columns.every(each)) return
	throw new CombError({ cause: "Invalid cursor", errorKey: combErrorKeys.INVALID_CURSOR, status: "bad_request" })
}

/** A cursor value as `column`'s driver binds it: SQLite's way on a SQLite column, as it is elsewhere (Postgres reads 'Infinity') */
const bindableOn = (column: SQLWrapper | undefined, value: unknown): unknown =>
	is(column, SQLiteColumn) ? bindableAs(column, value) : value

export {
	assertCursorFits,
	bindable,
	bindableAs,
	bindableIn,
	bindableOn,
	boundAsRead,
	boundCarried,
	boundForKeys,
	carriesOpaque,
	DateKey,
	readsBack,
	readsRounded,
	refersBack,
}
