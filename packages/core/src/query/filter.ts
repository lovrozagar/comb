/**
 * PostgREST-style filters and sort orders: parse and validate. DB-agnostic: no SQL, only
 * the AST and its checks. The grammar lives in filter-parse.ts, the checks in filter-validate.ts.
 */
import { FILTER_OPERATORS, parseFilter } from "./filter-parse.ts"
import { parseFilterNumber } from "./filter-typed.ts"
import {
	FILTER_LIMITS,
	OPERATORS_BY_TYPE,
	type FilterField,
	type FilterFieldSpec,
	type FilterLimits,
	type FilterValidationResult,
	type LimitsGiven,
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
 * An entry that is empty, names no field (`asc`, `.desc`, a trailing comma) or has whitespace around
 * it, and a field named twice, refuse the whole order as null, as parseFilter refuses a filter, rather
 * than drop it and widen the request to the default order.
 */
function parseOrder(input: string | null | undefined): SortField[] | null {
	const entries = orderEntries(input)
	const fields = entries.filter((entry) => typeof entry !== "string")
	return fields.length === entries.length && namedTwice(fields).length === 0 ? fields : null
}

/** Each field `fields` names more than once, once each */
function namedTwice(fields: readonly SortField[]): string[] {
	const seen = new Set<string>()
	const twice = new Set<string>()
	for (const { field } of fields) (seen.has(field) ? twice : seen).add(field)
	return [...twice]
}

/**
 * Each entry of `order` read as a sort field, or kept as its text when it is empty, names no field or
 * has whitespace around it, which the published pattern refuses too
 */
function orderEntries(input: string | null | undefined): Array<SortField | string> {
	if (!input) return []

	const fields: Array<SortField | string> = []
	const parts = input.split(",")

	for (const part of parts) {
		const trimmed = part.trim()

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
		if (!field || part !== trimmed) {
			fields.push(part)
			continue
		}

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
	parseFilterNumber,
	namedTwice,
	orderEntries,
	parseOrder,
	validateFilter,
	type FilterField,
	type FilterFieldSpec,
	type FilterLimits,
	type FilterValidationResult,
	type LimitsGiven,
}
