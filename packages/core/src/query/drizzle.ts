/**
 * Drizzle relational query helpers — thin abstraction for using
 * query-helpers with drizzle's relational query API.
 */
import { type SQL, sql } from "drizzle-orm"

import { createCursor, type CursorId, CURSOR_TIEBREAK_COLUMN, DEFAULT_SORT } from "./cursor.ts"
import { filterBySelect } from "./fields.ts"
import type { FilterAST, ParsedFields, SortField } from "./types.ts"

type DrizzleListOptions = {
	limit: number
	offset: number
	sortOrderBy: Record<string, "asc" | "desc">
}

/**
 * The `select` extra that counts every row the filter matches, for `paginate` to report. An
 * offset request gets it; a cursor request gets none, because the window would make the
 * database read every remaining row on each page, which is what keyset pagination avoids.
 */
function countExtra(query: { cursor?: string | null | undefined }): { _total?: SQL.Aliased<number> } {
	return query.cursor ? {} : { _total: sql<number>`cast(count(*) over() as integer)`.as("_total") }
}

/**
 * Rows the filter matches across all pages, or null when this page cannot know: a cursor page
 * (no count was selected), a page past the end (no row carried it), or a query without countExtra.
 */
function countOf(
	items: ReadonlyArray<{ _total?: number }>,
	query: { cursor?: string | undefined; page?: number | undefined },
): number | null {
	if (query.cursor) return null
	const first = items[0]
	if (first === undefined) return (query.page ?? 1) === 1 ? 0 : null
	return first._total ?? null
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
function drizzlePaginationResult<T extends { id?: CursorId }>(
	items: DrizzleListResult<T>[],
	query: {
		cursor?: string
		limit: number
		page?: number
		parsedFields?: ParsedFields | null | undefined
		parsedSort: SortField[]
	},
) {
	const hasMore = items.length > query.limit
	const sliced = hasMore ? items.slice(0, query.limit) : items

	/* Mint from the fat row and the same effective sort buildListQuery ordered
	   by, so the cursor's signature matches the next request's. */
	let nextCursor: string | null = null
	const lastItem = sliced.at(-1)
	/* any id the row holds, 0 and "" included, can carry the next page */
	if (hasMore && lastItem !== undefined && Object.hasOwn(lastItem, CURSOR_TIEBREAK_COLUMN)) {
		const sort = query.parsedSort.length > 0 ? query.parsedSort : DEFAULT_SORT.filter(({ field }) => field in lastItem)
		nextCursor = createCursor(lastItem as Record<string, unknown>, sort)
	}

	const pagination = {
		count: countOf(items, query),
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
