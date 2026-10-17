/**
 * PostgREST-style filters and sort orders: parse and validate. DB-agnostic: no SQL, only
 * the AST and its checks. The grammar lives in filter-parse.ts, the checks in filter-validate.ts.
 */
import { FILTER_OPERATORS, parseFilter } from "./filter-parse.ts"
import {
	FILTER_LIMITS,
	OPERATORS_BY_TYPE,
	type FilterLimits,
	type FilterValidationResult,
	validateFilter,
} from "./filter-validate.ts"
import type { SortDirection, SortField } from "./types.ts"

/**
 * Parse PostgREST-style `order` string into SortField array.
 *
 * Grammar:
 *   order  := entry ("," entry)*
 *   entry  := field ("." direction)? ("." nulls)?
 *   field  := any string not containing "." at the direction/nulls boundary
 *            (dotted relation paths OK: "author.name.asc")
 *   direction := "asc" | "desc"        (default "asc" when omitted)
 *   nulls     := "nullsfirst" | "nullslast"
 *
 * Examples:
 *   "name"                         → [{ field: "name", direction: "asc" }]
 *   "name.desc"                    → [{ field: "name", direction: "desc" }]
 *   "name.asc.nullslast"           → [{ field: "name", direction: "asc", nulls: "last" }]
 *   "col1.desc,col2.asc.nullsfirst"
 *     → [{field:"col1",direction:"desc"}, {field:"col2",direction:"asc",nulls:"first"}]
 *
 * Malformed entries are dropped silently — downstream schema validator
 * rejects unknown fields, which catches most mistakes.
 */
function parseOrder(input: string | null | undefined): SortField[] {
	if (!input || input.trim() === "") return []

	const fields: SortField[] = []
	const parts = input.split(",")

	for (const part of parts) {
		const trimmed = part.trim()
		if (!trimmed) continue

		const tokens = trimmed.split(".")

		let nulls: "first" | "last" | undefined
		const last = tokens[tokens.length - 1]
		if (last === "nullsfirst") {
			nulls = "first"
			tokens.pop()
		} else if (last === "nullslast") {
			nulls = "last"
			tokens.pop()
		}

		let direction: SortDirection = "asc"
		const newLast = tokens[tokens.length - 1]
		if (newLast === "asc") {
			tokens.pop()
		} else if (newLast === "desc") {
			direction = "desc"
			tokens.pop()
		}

		const field = tokens.join(".")
		if (!field) continue

		const entry: SortField = { direction, field }
		if (nulls) entry.nulls = nulls
		fields.push(entry)
	}

	return fields
}

export {
	FILTER_LIMITS,
	FILTER_OPERATORS,
	OPERATORS_BY_TYPE,
	parseFilter,
	parseOrder,
	validateFilter,
	type FilterLimits,
	type FilterValidationResult,
}
