/**
 * A validated filter value as its SQLite column stores it (Q5 of the 0.14.1 review): an ISO date
 * field's instant, which validateFilter types in `toISOString()`'s form, is epoch milliseconds on a
 * date or number column, which the date paths then bind in the column's own unit; text as it is.
 */
import type { SQLiteColumn } from "drizzle-orm/sqlite-core"
import type { FilterCondition } from "../types.ts"

/* an ISO date field's value as validateFilter types it: the instant, in toISOString()'s form */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** `value`, an ISO instant, as epoch milliseconds; any other value as it is */
const instantMs = (value: unknown): unknown =>
	typeof value === "string" && ISO_INSTANT.test(value) ? Date.parse(value) : value

/** `condition` with an ISO date field's instant as `column` stores it */
function asStored(condition: FilterCondition, column: SQLiteColumn): FilterCondition {
	if (column.dataType !== "object date" && !column.dataType.startsWith("number")) return condition
	const { value } = condition
	return { ...condition, value: Array.isArray(value) ? value.map(instantMs) : instantMs(value) }
}

export { asStored }
