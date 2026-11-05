/**
 * The values a filter names for one field or several: queryHelpers.filterValue and filterValues.
 * A value is read only where the filter holds every row to it: a condition under
 * the operator asked for (`eq` by default), at the top level of an AND, and the only one there on
 * its field. `project_id.ne.p1`, an `or()` group and a field named twice read as nothing, since
 * the SQL serves rows other than that value's.
 */
import type { FilterAST, FilterCondition, FilterOperator } from "./types.ts"

/** An operator by its one meaning: `neq` is `ne` */
const meaningOf = (operator: FilterOperator): FilterOperator => (operator === "neq" ? "ne" : operator)

/** The one top-level AND condition on `field` under `operator`, or undefined when there is none or more than one */
function heldTo(filterAst: FilterAST | null, field: string, operator: FilterOperator): FilterCondition | undefined {
	const root = filterAst?.root
	if (!root) return undefined
	/* an OR of one member holds every row to it as an AND does */
	if (root.logic !== "and" && root.conditions.length + root.subgroups.length > 1) return undefined
	const wanted = meaningOf(operator)
	const matches = root.conditions.filter((c) => c.field === field && meaningOf(c.operator) === wanted)
	return matches.length === 1 ? matches[0] : undefined
}

/** The value the filter holds every row's `field` to under `operator` (`eq` by default), or undefined */
function extractFilterValue<T = unknown>(
	filterAst: FilterAST | null,
	field: string,
	operator: FilterOperator = "eq",
): T | undefined {
	return heldTo(filterAst, field, operator)?.value as T | undefined
}

/** Each of `fields` the filter holds every row to under `operator` (`eq` by default), as extractFilterValue reads it */
function extractFilterValues<T extends Record<string, unknown>>(
	filterAst: FilterAST | null,
	fields: (keyof T)[],
	operator: FilterOperator = "eq",
): Partial<T> {
	const result: Partial<T> = {}
	for (const field of fields) {
		const condition = heldTo(filterAst, String(field), operator)
		if (condition) result[field] = condition.value as T[keyof T]
	}
	return result
}

export { extractFilterValue, extractFilterValues }
