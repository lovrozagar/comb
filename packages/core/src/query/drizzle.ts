/**
 * Drizzle relational query helpers — thin abstraction for using
 * query-helpers with drizzle's relational query API.
 */
import { type SQL, type SQLWrapper, sql } from "drizzle-orm"

import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"

import { type CursorId, CursorRef, CURSOR_TIEBREAK_COLUMN, readCursor } from "./cursor.ts"
import { anchored, type KeysetKind, mintWithin } from "./cursor-ref.ts"
import { assertCursorWired, type CursorOptions } from "./cursor-seal.ts"
import { atCursorPrecision, boundAs } from "./cursor-precision.ts"
import { assertCursorFits, bindableOn } from "./sqlite/cursor-fit.ts"
import { filterBySelect } from "./fields.ts"
import { extractFilterValue, extractFilterValues } from "./filter-values.ts"
import { anchorGone, keysetSQL, orderByKeys, type SortKey } from "./sqlite/keyset.ts"
import { assertPageWithin, assertSchemaParsed } from "./trusted.ts"
import type { ParsedFields, SortField } from "./types.ts"
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
	/** Whether the cursor's anchor is gone where no bound is safe, for `findMany({ extras })`: paginate reads it (U26) */
	extras?: { _combAnchorGone: (table: RelationalTable) => SQL }
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
		parsedSort: SortField[]
		sortOrderBy: Record<string, "asc" | "desc">
		validated?: true | undefined
	},
	options: CursorOptions,
): DrizzleListOptions {
	assertSchemaParsed(query)
	/* options that cannot seal are a wiring mistake on page 1 too, not only once a cursor comes back */
	assertCursorWired(options)
	const sort = query.parsedSort
	const orderBy = (table: RelationalTable) => {
		const { keys, tiebreak } = keysOn(table, sort)
		return orderByKeys(atCursorPrecision(keys), tiebreak)
	}
	const base = { limit: query.limit + 1, orderBy, sortOrderBy: query.sortOrderBy }
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
		/* a value the keyset reads from the row is anchored first; the others bind as their keys compare them */
		const values = boundAs(
			keys,
			anchored(
				keys,
				cursor.values.map((value, i) => bindableOn(keys[i]?.column, value)),
				{ id, nonFinite: options.nonFinite, table, tiebreak: tiebreak.column },
			),
		)
		return { id, keys: atCursorPrecision(keys), tiebreak, values }
	}
	const where = (table: RelationalTable) => keysetSQL(positionOn(table))
	if (!cursor.values.some((value) => value instanceof CursorRef)) return { ...base, offset: 0, where: { RAW: where } }
	/* a reference may have no safe bound once its row is gone: the flag tells paginate, which has no database */
	const gone = (table: RelationalTable) => anchorGone(positionOn(table).values) ?? sql`0`
	return { ...base, extras: { _combAnchorGone: gone }, offset: 0, where: { RAW: where } }
}

type DrizzleListResult<T> = T & { _total?: number }

/** `_total` is a window extra, never a public field. Callers read pagination.count. */
function stripWindowTotal<T extends Record<string, unknown>>(row: T): T {
	if (!Object.hasOwn(row, "_total") && !Object.hasOwn(row, "_combAnchorGone")) return row
	const rest = { ...row }
	delete rest["_total"]
	delete rest["_combAnchorGone"]
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

/**
 * The next cursor, minted from the last row of the page. A row without a sort key or the id
 * would mint a cursor that repeats or ends the list, so that is a wiring mistake: select them.
 * Any id the row holds, 0 and "" included, carries the next page.
 */
function mintFrom(row: object, parsedSort: SortField[], options: PaginateOptions): string {
	const { idField } = options
	const missing = [...parsedSort.map(({ field }) => field), idField ?? CURSOR_TIEBREAK_COLUMN].filter(
		(key) => !Object.hasOwn(row, key),
	)
	if (missing.length > 0) {
		throw new CombError({
			cause: `paginate mints the next cursor from each row's ${missing.join(", ")}; select them`,
			errorKey: combErrorKeys.SORT_NOT_WIRED,
			status: "internal_server_error",
		})
	}
	/* a key too long for the cap goes by reference; a derived list, which cannot read it, says so on page 1 */
	return mintWithin(row as Record<string, unknown>, parsedSort, options)
}

/**
 * paginate's options: the cursor secret and scope, the field a row's tiebreak id is in (default
 * `id`), and `keyset: "derived"` for a buildDerivedListQuery list, whose keys no row holds
 */
type PaginateOptions = CursorOptions & { idField?: string | undefined; keyset?: KeysetKind | undefined }

/**
 * Create pagination result from drizzle query results with _total extra, the next cursor sealed
 * under `options` and keyed by `idField`, as buildDerivedListQuery's idColumn keys the page
 */
function drizzlePaginationResult<T extends object>(
	items: DrizzleListResult<T>[],
	query: {
		cursor?: string
		limit: number
		page?: number
		parsedFields?: ParsedFields | null | undefined
		parsedSort: SortField[]
		validated?: true | undefined
	},
	options: PaginateOptions,
): readonly [T[], PaginationMeta] {
	assertCursorWired(options)
	/* read before anything else, _total included: a list past a gone anchor is no page of it (U26) */
	if (items.some((item) => Number((item as Record<string, unknown>)["_combAnchorGone"]) === 1)) {
		throw new CombError({
			cause:
				"the row this cursor resumes from was renamed or deleted, and no bound is safe under its collation; start the list again",
			errorKey: combErrorKeys.INVALID_CURSOR,
			status: "bad_request",
		})
	}
	const hasMore = items.length > query.limit
	const sliced = hasMore ? items.slice(0, query.limit) : items

	/* Mint from the fat row and the same effective sort buildListQuery ordered
	   by, so the cursor's signature matches the next request's. */
	const lastItem = sliced.at(-1)
	const nextCursor = hasMore && lastItem !== undefined ? mintFrom(lastItem, query.parsedSort, options) : null

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

export { type CursorOptions, type DrizzleListOptions, type PaginateOptions, queryHelpers }
