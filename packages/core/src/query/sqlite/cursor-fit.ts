/**
 * A cursor is client input: its values reach the keyset predicate as bound parameters, so each one
 * must be what its column holds. A real row encodes exactly that; anything else is a forged or
 * stale cursor, answered with a 400 before drizzle maps it (a string on a timestamp column would
 * otherwise throw a TypeError, a 500).
 */
import { Column, is, type SQLWrapper } from "drizzle-orm"

import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"

/** Whether `value` is what a column of this drizzle `dataType` holds; json, bigint and blobs hold nothing a cursor carries */
function fitsDataType(dataType: string, value: unknown): boolean {
	switch (dataType.split(" ")[0]) {
		case "string":
			return typeof value === "string"
		case "number":
			return typeof value === "number"
		case "boolean":
			return typeof value === "boolean"
		case "object":
			return dataType === "object date" && value instanceof Date
		default:
			return false
	}
}

/** Null fits every column; a SQL expression (a derived sort) has no declared type to check against */
function fits(column: SQLWrapper, value: unknown): boolean {
	return value === null || !is(column, Column) || fitsDataType(column.dataType, value)
}

/** Throw a 400 unless every cursor value, the tiebreak id last, fits its column */
function assertCursorFits(columns: readonly SQLWrapper[], values: readonly unknown[]): void {
	if (columns.every((column, index) => fits(column, values[index]))) return
	throw new CombError({ cause: "Invalid cursor", errorKey: combErrorKeys.INVALID_CURSOR, status: "bad_request" })
}

export { assertCursorFits }
