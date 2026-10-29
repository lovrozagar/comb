/**
 * A validated filter value as its SQLite column stores it (Q5 of the 0.14.1 review, Q4 of r17): an
 * ISO date field's instant, which validateFilter types as an IsoInstant, is its epoch milliseconds
 * on a date or number column, which the date paths then bind in the column's own unit, and its
 * `toISOString()` text on any other; every other value as it is.
 */
import type { SQLiteColumn } from "drizzle-orm/sqlite-core"
import { IsoInstant } from "../iso-date.ts"
import type { FilterCondition } from "../types.ts"

/** `value` as `column` stores it: an instant by its milliseconds on a date or number column, else its text */
function stored(value: unknown, column: SQLiteColumn): unknown {
	if (!(value instanceof IsoInstant)) return value
	return column.dataType === "object date" || column.dataType.startsWith("number") ? value.ms : value.text
}

/** `condition` with an ISO date field's instant as `column` stores it */
function asStored(condition: FilterCondition, column: SQLiteColumn): FilterCondition {
	const { value } = condition
	return { ...condition, value: Array.isArray(value) ? value.map((v) => stored(v, column)) : stored(value, column) }
}

export { asStored }
