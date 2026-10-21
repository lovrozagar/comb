/**
 * A cursor is client input: its values reach the keyset predicate as bound parameters, so each one
 * must be what its column holds. A real row encodes exactly that; anything else is a forged or
 * stale cursor, answered with a 400 before drizzle maps it (a string on a timestamp column would
 * otherwise throw a TypeError, a 500).
 */
import { Column, is, type SQL, type SQLWrapper } from "drizzle-orm"

import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"

/** Whether `value` is what a column of this drizzle `dataType` holds; json and blobs hold nothing a cursor carries */
function fitsDataType(dataType: string, value: unknown): boolean {
	switch (dataType.split(" ")[0]) {
		case "string":
			return typeof value === "string"
		case "number":
			return typeof value === "number"
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
 * value is a Date, bound as that number
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

/**
 * Null fits every key. A column takes what its dataType holds; a key declared as time, a Date; any
 * other SQL expression (a derived sort) only what every driver binds as it is: a string, a number
 * or a boolean (bun:sqlite and D1 refuse a Date that libsql would bind)
 */
function fits(column: SQLWrapper, value: unknown): boolean {
	if (value === null) return true
	if (column instanceof DateKey) return value instanceof Date
	if (is(column, Column)) return fitsDataType(column.dataType, value)
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

/** The cursor's values as the keys bind them: a Date on a key declared as time, as its epoch milliseconds */
const boundForKeys = (columns: readonly SQLWrapper[], values: readonly unknown[]): unknown[] =>
	values.map((value, i) => (columns[i] instanceof DateKey && value instanceof Date ? value.getTime() : value))

/** Throw a 400 unless every cursor value, the tiebreak id last, fits its column */
function assertCursorFits(columns: readonly SQLWrapper[], values: readonly unknown[]): void {
	if (columns.every((column, index) => fits(column, values[index]))) return
	throw new CombError({ cause: "Invalid cursor", errorKey: combErrorKeys.INVALID_CURSOR, status: "bad_request" })
}

export { assertCursorFits, boundForKeys, DateKey }
