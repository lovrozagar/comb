/**
 * Drizzle relational query helpers — thin abstraction for using
 * query-helpers with drizzle's relational query API.
 */
import { type SQL, type SQLWrapper, sql } from "drizzle-orm"

import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"

import { createCursor, type CursorId, CURSOR_TIEBREAK_COLUMN, DEFAULT_SORT, readCursor } from "./cursor.ts"
import { filterBySelect } from "./fields.ts"
import { keysetSQL, orderByKeys, type SortKey } from "./sqlite/keyset.ts"
import { assertSchemaParsed } from "./trusted.ts"
import type { FilterAST, ParsedFields, SortField } from "./types.ts"
import type { paginationResponseSchema } from "./schema.ts"
import type * as z from "zod"

/** The pagination meta paginate returns: the list response's own schema */
type PaginationMeta = z.output<typeof paginationResponseSchema>

/** A table as drizzle's relational callbacks hand it over, holding its columns as own properties */
type RelationalTable = object

type DrizzleListOptions = {
	limit: number
	offset: number
	/** The sort, its null placement and the id tiebreak, for `findMany({ orderBy })` */
	orderBy: (table: RelationalTable) => SQL[]
	/** @deprecated by orderBy, which also breaks ties and places nulls */
	sortOrderBy: Record<string, "asc" | "desc">
	/** The keyset predicate of a cursor request, for `findMany({ where })` (AND it with your own) */
	where?: { RAW: (table: RelationalTable) => SQL }
}

/**
 * The parsed request, or the `ListQueryResult` built from it: what a service or a repository holds.
 * Closed on purpose: a bare `{ cursor? }` took any object, so a wrong argument compiled and counted.
 */
type CountQuery =
	| { cursor?: string | null | undefined; limit: number; parsedSort: readonly SortField[] }
	| { meta: { type: "cursor" | "offset" } }

/**
 * The `select` extra that counts every row the filter matches, for `paginate` to report. An
 * offset request gets it; a cursor request gets none, because the window would make the
 * database read every remaining row on each page, which is what keyset pagination avoids.
 */
function countExtra(query: CountQuery): { _total?: SQL.Aliased<number> } {
	const cursor = "meta" in query ? query.meta.type === "cursor" : Boolean(query.cursor)
	return cursor ? {} : { _total: sql<number>`cast(count(*) over() as integer)`.as("_total") }
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

/** The sort keys and tiebreak against the queried table; a sort field it lacks is a wiring mistake */
function keysOn(table: RelationalTable, sort: readonly SortField[]): { keys: SortKey[]; tiebreak: SortKey } {
	const column = (field: string): SQLWrapper => {
		if (Object.hasOwn(table, field)) return (table as Record<string, SQLWrapper>)[field] as SQLWrapper
		throw new CombError({
			cause: `Sort field '${field}' is not a column of the queried table`,
			errorKey: combErrorKeys.CURSOR_PAGINATION_UNSUPPORTED,
			status: "internal_server_error",
		})
	}
	const keys = sort.map(({ direction, field, nulls }) => ({ column: column(field), direction, nulls }))
	return { keys, tiebreak: { column: column(CURSOR_TIEBREAK_COLUMN), direction: sort[0]?.direction ?? "desc" } }
}

/**
 * limit, offset, order and the cursor predicate for drizzle's relational `findMany`, from the
 * list query schema's output. The limit is one over the page so `paginate` can tell there is more.
 */
function drizzleListOptions(query: {
	cursor?: string | undefined
	limit: number
	page?: number | undefined
	parsedSort: SortField[]
	sortOrderBy: Record<string, "asc" | "desc">
	validated?: true | undefined
}): DrizzleListOptions {
	assertSchemaParsed(query)
	const sort = query.parsedSort
	const orderBy = (table: RelationalTable) => {
		const { keys, tiebreak } = keysOn(table, sort)
		return orderByKeys(keys, tiebreak)
	}
	const base = { limit: query.limit + 1, orderBy, sortOrderBy: query.sortOrderBy }
	if (!query.cursor) return { ...base, offset: ((query.page ?? 1) - 1) * query.limit }
	const cursor = readCursor(query.cursor, sort)
	const where = (table: RelationalTable) => {
		const { keys, tiebreak } = keysOn(table, sort)
		return keysetSQL({ id: cursor.id, keys, tiebreak, values: cursor.values })
	}
	return { ...base, offset: 0, where: { RAW: where } }
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
		validated?: true | undefined
	},
): readonly [T[], PaginationMeta] {
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

	const pagination: PaginationMeta = {
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

/** List-query helpers for drizzle queries: count, options, pagination, projection */
const queryHelpers: {
	countExtra: typeof countExtra
	filterValue: typeof extractFilterValue
	filterValues: typeof extractFilterValues
	listOptions: typeof drizzleListOptions
	paginate: typeof drizzlePaginationResult
	project: typeof drizzleProject
} = {
	countExtra,
	filterValue: extractFilterValue,
	filterValues: extractFilterValues,
	listOptions: drizzleListOptions,
	paginate: drizzlePaginationResult,
	project: drizzleProject,
}

export { type DrizzleListOptions, queryHelpers }
