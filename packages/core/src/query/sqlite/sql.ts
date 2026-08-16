/**
 * SQLite JSON column helpers for raw SQL query building.
 */
import type { SQLiteColumn } from "drizzle-orm/sqlite-core"

import type { SortDirection } from "../types.ts"

/** JSON column with same API name as DB column */
function jsonCol(col: SQLiteColumn, alias: string): string {
	return `'${col.name}', ${alias}.${col.name}`
}

/** JSON column with different API name than DB column */
function jsonColAs(apiName: string, col: SQLiteColumn, alias: string): string {
	return `'${apiName}', ${alias}.${col.name}`
}

/** JSON boolean column (SQLite stores as 0/1) */
function jsonBool(col: SQLiteColumn, alias: string): string {
	return `'${col.name}', CASE WHEN ${alias}.${col.name} = 1 THEN json('true') ELSE json('false') END`
}

/** JSON nullable column with json() wrapper */
function jsonNullable(col: SQLiteColumn, alias: string): string {
	return `'${col.name}', CASE WHEN ${alias}.${col.name} IS NOT NULL THEN json(${alias}.${col.name}) ELSE NULL END`
}

/** Column definition for buildScalarJsonParts */
type ScalarColDef = {
	always?: boolean
	api: string
	col: SQLiteColumn
	type?: "bool" | "json"
}

/** Build JSON parts from column definitions */
function buildScalarJsonParts(
	defs: ScalarColDef[],
	opts: { alias: string; cols: Record<string, boolean> | null; includeAll: boolean },
): string[] {
	const parts: string[] = []
	for (const def of defs) {
		if (def.always || opts.includeAll || opts.cols?.[def.api]) {
			if (def.type === "bool") {
				parts.push(jsonBool(def.col, opts.alias))
			} else if (def.type === "json") {
				parts.push(jsonNullable(def.col, opts.alias))
			} else if (def.api !== def.col.name) {
				parts.push(jsonColAs(def.api, def.col, opts.alias))
			} else {
				parts.push(jsonCol(def.col, opts.alias))
			}
		}
	}
	return parts
}

const SQL_SORT_DIR = {
	asc: "ASC",
	desc: "DESC",
} as const satisfies Record<SortDirection, string>

export { buildScalarJsonParts, jsonBool, jsonCol, jsonColAs, jsonNullable, type ScalarColDef, SQL_SORT_DIR }
