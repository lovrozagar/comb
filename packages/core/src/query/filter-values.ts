/** The values a filter names for one field or several: queryHelpers.filterValue and filterValues */
import type { FilterAST } from "./types.ts"

/** Extract a single filter value from FilterAST */
function extractFilterValue<T = unknown>(filterAst: FilterAST | null, field: string): T | undefined {
	if (!filterAst?.root.conditions) {
		return undefined
	}

	const condition = filterAst.root.conditions.find((c) => c.field === field)
	if (!condition) {
		return undefined
	}

	return condition.value as T
}

/** Extract multiple filter values from FilterAST */
function extractFilterValues<T extends Record<string, unknown>>(
	filterAst: FilterAST | null,
	fields: (keyof T)[],
): Partial<T> {
	const result: Partial<T> = {}

	if (!filterAst?.root.conditions) {
		return result
	}

	for (const field of fields) {
		const condition = filterAst.root.conditions.find((c) => c.field === field)
		if (condition) {
			result[field] = condition.value as T[keyof T]
		}
	}

	return result
}

export { extractFilterValue, extractFilterValues }
