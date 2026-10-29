/**
 * Drizzle relational query helpers — thin abstraction for using
 * query-helpers with drizzle's relational query API.
 */
import { type SQL, type SQLWrapper, sql } from "drizzle-orm"

import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"

import { type CursorId, CursorRef, CURSOR_TIEBREAK_COLUMN, readCursor } from "./cursor.ts"
import { anchored } from "./cursor-ref.ts"
import type { CursorOptions } from "./cursor-seal.ts"
import { assertCursorFits, bindableOn } from "./sqlite/cursor-fit.ts"
import { extractFilterValue, extractFilterValues } from "./filter-values.ts"
import { anchorGone, keysetSQL, orderByKeys, type SortKey } from "./sqlite/keyset.ts"
import { applySelect, type ListPagination, paginate, paginationOf } from "./pagination.ts"
import { assertPageWithin, assertSchemaParsed } from "./trusted.ts"
import type { ParsedFields, SortField } from "./types.ts"

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
	/** Whether the cursor's anchor is gone where no bound is safe, for `findMany({ extras })`: paginate reads it (U26) */
	extras?: { _combAnchorGone: (table: RelationalTable) => SQL }
	/** How `paginate` pages the rows these options read (pagination.ts) */
	pagination: ListPagination
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
 * list query schema's output, the cursor opened under `options`: the app's secret and the list's
 * scope. The limit is one over the page so `paginate` can tell there is more.
 */
function drizzleListOptions(
	query: {
		cursor?: string | undefined
		limit: number
		page?: number | undefined
		parsedFields?: ParsedFields | null | undefined
		parsedSort: SortField[]
		sortOrderBy: Record<string, "asc" | "desc">
		validated?: true | undefined
	},
	options: CursorOptions,
): DrizzleListOptions {
	assertSchemaParsed(query)
	/* options that cannot seal are a wiring mistake on page 1 too, not only once a cursor comes back */
	const pagination = paginationOf(options, { cursorable: true, query, window: query.limit + 1 })
	const sort = query.parsedSort
	const orderBy = (table: RelationalTable) => {
		const { keys, tiebreak } = keysOn(table, sort)
		return orderByKeys(keys, tiebreak)
	}
	const base = { limit: query.limit + 1, orderBy, pagination, sortOrderBy: query.sortOrderBy }
	if (!query.cursor) {
		/* a page no schema bounded is bounded here, as buildListQuery bounds it (U5) */
		assertPageWithin(query)
		return { ...base, offset: ((query.page ?? 1) - 1) * query.limit }
	}
	const cursor = readCursor(query.cursor, sort, options)
	const positionOn = (table: RelationalTable) => {
		const { keys, tiebreak } = keysOn(table, sort)
		/* the cursor is client input: each value must be what its column holds, or it is a 400 */
		assertCursorFits([...keys.map(({ column }) => column), tiebreak.column], [...cursor.values, cursor.id])
		const id = bindableOn(tiebreak.column, cursor.id) as CursorId
		/* a value the keyset reads from the row is anchored; the others bind as their keys compare them */
		const values = anchored(
			keys,
			cursor.values.map((value, i) => bindableOn(keys[i]?.column, value)),
			{ id, nonFinite: options.nonFinite, table, tiebreak: tiebreak.column },
		)
		return { id, keys, tiebreak, values }
	}
	const where = (table: RelationalTable) => keysetSQL(positionOn(table))
	if (!cursor.values.some((value) => value instanceof CursorRef)) return { ...base, offset: 0, where: { RAW: where } }
	/* a reference may have no safe bound once its row is gone: the flag tells paginate, which has no database */
	const gone = (table: RelationalTable) => anchorGone(positionOn(table).values) ?? sql`0`
	return { ...base, extras: { _combAnchorGone: gone }, offset: 0, where: { RAW: where } }
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
	paginate: typeof paginate
	project: typeof drizzleProject
} = {
	countExtra,
	filterValue: extractFilterValue,
	filterValues: extractFilterValues,
	listOptions: drizzleListOptions,
	paginate,
	project: drizzleProject,
}

export { type CursorOptions, type DrizzleListOptions, queryHelpers }
