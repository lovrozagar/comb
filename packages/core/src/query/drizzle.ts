/**
 * Drizzle relational query helpers — thin abstraction for using
 * query-helpers with drizzle's relational query API.
 */
import { sql } from "drizzle-orm"

import { createCursor } from "./cursor.ts"
import { filterBySelect } from "./fields.ts"
import type { FilterAST, ParsedFields, SortField } from "./types.ts"

type DrizzleListOptions = {
	limit: number
	offset: number
	sortOrderBy: Record<string, "asc" | "desc">
}

/** Drizzle extras for total count via window function */
function countExtra() {
	return {
		_total: sql<number>`cast(count(*) over() as integer)`.as("_total"),
	}
}

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

/** Compute limit/offset/sortOrderBy from schema output — hides limit+1 internally */
function drizzleListOptions(query: {
	cursor?: string
	limit: number
	page?: number
	sortOrderBy: Record<string, "asc" | "desc">
}): DrizzleListOptions {
	return {
		limit: query.limit + 1,
		offset: query.cursor ? 0 : ((query.page ?? 1) - 1) * query.limit,
		sortOrderBy: query.sortOrderBy,
	}
}

type DrizzleListResult<T> = T & { _total?: number }

/** `_total` is a window extra, never a public field. Callers read pagination.count. */
function stripWindowTotal<T extends Record<string, unknown>>(row: T): T {
	if (!Object.hasOwn(row, "_total")) return row
	const rest = { ...row }
	delete rest["_total"]
	return rest
}

/**
 * Last mutation of item shape. Query stays fat; the returned object is the
 * public subset. No-op (minus `_total`) when parsedFields is null.
 */
function applySelect<T extends Record<string, unknown>>(row: T, parsedFields: ParsedFields | null): T {
	const publicRow = stripWindowTotal(row)
	if (!parsedFields) return publicRow
	return filterBySelect(publicRow, parsedFields) as T
}

/** Create pagination result from drizzle query results with _total extra */
function drizzlePaginationResult<T extends { id?: string }>(
	items: DrizzleListResult<T>[],
	query: {
		cursor?: string
		limit: number
		page?: number
		parsedFields?: ParsedFields | null | undefined
		parsedSort: SortField[]
	},
) {
	const total = items[0]?._total ?? 0
	const hasMore = items.length > query.limit
	const sliced = hasMore ? items.slice(0, query.limit) : items

	let nextCursor: string | null = null
	if (hasMore && sliced.length > 0) {
		const lastItem = sliced[sliced.length - 1]
		if (lastItem?.id) {
			const sortField = query.parsedSort[0]?.field ?? "createdAt"
			nextCursor = createCursor(lastItem as { id: string }, sortField)
		}
	}

	const pagination = {
		count: total,
		hasMore,
		limit: query.limit,
		nextCursor,
		page: query.cursor ? null : (query.page ?? 1),
	}

	/* Project after the slice so count / hasMore / cursor still see the fat row. */
	const projected = sliced.map((item) => applySelect(item as T & Record<string, unknown>, query.parsedFields ?? null))

	return [projected, pagination] as const
}

function drizzleProject<T extends Record<string, unknown>>(row: T, parsedFields: ParsedFields | null): T {
	return applySelect(row, parsedFields)
}

const drizzle = {
	countExtra,
	filterValue: extractFilterValue,
	filterValues: extractFilterValues,
	listOptions: drizzleListOptions,
	paginate: drizzlePaginationResult,
	project: drizzleProject,
}

export { drizzle, type DrizzleListOptions }
