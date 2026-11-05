/**
 * The SQL keyword of each sort direction, for raw SQL query building.
 */
import type { SortDirection } from "../types.ts"

/** The SQL keyword of each sort direction */
const SQL_SORT_DIR: {
	/** the keyword of an ascending sort */
	readonly asc: "ASC"
	/** the keyword of a descending sort */
	readonly desc: "DESC"
} = {
	asc: "ASC",
	desc: "DESC",
} as const satisfies Record<SortDirection, string>

export { SQL_SORT_DIR }
