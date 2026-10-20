/**
 * The SQL keyword of each sort direction, for raw SQL query building.
 */
import type { SortDirection } from "../types.ts"

const SQL_SORT_DIR: { readonly asc: "ASC"; readonly desc: "DESC" } = {
	asc: "ASC",
	desc: "DESC",
} as const satisfies Record<SortDirection, string>

export { SQL_SORT_DIR }
