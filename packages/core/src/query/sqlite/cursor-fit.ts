/**
 * A cursor is client input: its values reach the keyset predicate as bound parameters, so each one
 * must be what its column holds. A real row encodes exactly that; anything else is a forged or
 * stale cursor, answered with a 400 before drizzle maps it (a string on a timestamp column would
 * otherwise throw a TypeError, a 500).
 */
import { Column, is, type SQL, type SQLWrapper, sql } from "drizzle-orm"
import { SQLiteColumn } from "drizzle-orm/sqlite-core"

import { CombError } from "../../error.ts"
import { CursorRef } from "../cursor.ts"
import { combErrorKeys } from "../../types.ts"

/**
 * Whether `value` is what a column of this drizzle `dataType` holds; json and blobs hold nothing a
 * cursor carries. A number column holds a bigint too where the driver returns integers as one
 * (libsql's intMode "bigint", bun:sqlite's safeIntegers), and a cursor minted from its row carries it.
 */
function fitsDataType(dataType: string, value: unknown): boolean {
	switch (dataType.split(" ")[0]) {
		case "string":
			return typeof value === "string"
		case "number":
			return typeof value === "number" || typeof value === "bigint"
		case "boolean":
			return typeof value === "boolean"
		case "bigint":
			return typeof value === "bigint"
		case "object":
			return dataType === "object date" && value instanceof Date
		default:
			return false
	}
}

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

const isInteger = (value: unknown) => typeof value === "bigint" || (typeof value === "number" && Number.isFinite(value))

/**
 * Null fits every key. A column takes what its dataType holds; a key declared as time, a Date or
 * the epoch milliseconds its row selected; any other SQL expression (a derived sort) only what
 * every driver binds: a string, a number, a bigint or a boolean (bun:sqlite and D1 refuse a Date
 * that libsql would bind)
 */
function fits(column: SQLWrapper, value: unknown): boolean {
	if (value === null) return true
	/* a reference reads a text column's value from the row: no other key holds one */
	if (value instanceof CursorRef) return is(column, Column) && column.dataType.startsWith("string")
	if (column instanceof DateKey) return value instanceof Date || isInteger(value)
	if (is(column, Column)) return fitsDataType(column.dataType, value)
	return (
		typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
	)
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

/** Whether `column` is a seconds-mode SQLite timestamp: drizzle binds a Date there floored to the second */
const inSeconds = (column: SQLWrapper | undefined): boolean =>
	is(column, SQLiteColumn) &&
	column.columnType === "SQLiteTimestamp" &&
	(column as unknown as { mode?: unknown }).mode === "timestamp"

/**
 * A Date on a seconds-mode timestamp key as the seconds it holds, to the millisecond (U10): drizzle
 * would floor it to the second. A key the keyset can read from its row reads it there instead
 * (cursor-ref.ts), as a stored fraction below a millisecond is one no Date holds.
 */
const exactSeconds = (value: Date): SQL => sql`${value.getTime() / 1000}`

/** The cursor's values as the keys bind them: a Date on a key declared as time as its epoch milliseconds, a safe bigint as a number */
const boundForKeys = (columns: readonly SQLWrapper[], values: readonly unknown[]): unknown[] =>
	values.map((value, i) => (columns[i] instanceof DateKey && value instanceof Date ? value.getTime() : bindable(value)))

/** Throw a 400 unless every cursor value, the tiebreak id last, fits its column */
function assertCursorFits(columns: readonly SQLWrapper[], values: readonly unknown[]): void {
	if (columns.every((column, index) => fits(column, values[index]))) return
	throw new CombError({ cause: "Invalid cursor", errorKey: combErrorKeys.INVALID_CURSOR, status: "bad_request" })
}

/** A cursor value as `column`'s driver binds it: SQLite's way on a SQLite column, as it is elsewhere (Postgres reads 'Infinity') */
const bindableOn = (column: SQLWrapper | undefined, value: unknown): unknown =>
	is(column, SQLiteColumn) ? bindable(value) : value

export { assertCursorFits, bindable, bindableOn, boundForKeys, DateKey, exactSeconds, inSeconds }
