/**
 * Drizzle relational query helpers — thin abstraction for using
 * query-helpers with drizzle's relational query API.
 */
import type { Column, SQL, SQLWrapper } from "drizzle-orm"
import { sql } from "drizzle-orm"

import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"

import { type CursorId, CursorRef, CURSOR_TIEBREAK_COLUMN, readCursor } from "./cursor.ts"
import { anchored } from "./cursor-ref.ts"
import { assertCursorWired, type CursorOptions } from "./cursor-seal.ts"
import { assertCursorFits, bindableOn, boundCarried } from "./sqlite/cursor-fit.ts"
import { extractFilterValue, extractFilterValues } from "./filter-values.ts"
import { anchorGone, keysetSQL, orderByKeys, type SortKey } from "./sqlite/keyset.ts"
import { keyTextsSQL } from "./sqlite/list-finish.ts"
import { applySelect, type ListExtra, type ListPagination, paginate, paginationOf } from "./pagination.ts"
import { assertLimitWithin, assertPageWithin, assertSchemaParsed } from "./trusted.ts"
import type { ListQueryInput, ParsedFields, SortField } from "./types.ts"

/** A table as drizzle's relational callbacks hand it over, holding its columns as own properties */
export type RelationalTable = object

type DrizzleListOptions = {
	limit: number
	offset: number
	/** The sort, its null placement and the id tiebreak, for `findMany({ orderBy })` */
	orderBy: (table: RelationalTable) => SQL[]
	/**
	 * For `findMany({ extras })`, which paginate reads and refuses a page without (Q3 of r17): the
	 * tiebreak the next cursor resumes from (Q2), an offset page's count, and, on a cursor that
	 * carries a reference, whether its anchor is gone where no bound is safe (U26)
	 */
	extras: { _combId: (table: RelationalTable) => SQL } & Partial<{
		_combAnchorGone: (table: RelationalTable) => SQL<number>
		/* each sort key's stored text where its read rounds it (QL3 of r22b); on every list with a sort */
		_combKeyTexts: (table: RelationalTable) => SQL<string>
		_total: (table: RelationalTable) => SQL<number>
	}>
	/** How `paginate` pages the rows these options read (pagination.ts) */
	pagination: ListPagination & { merged: false }
} & Partial<{
	/** The keyset predicate of a cursor request, for `findMany({ where })` (AND it with your own) */
	where: { RAW: (table: RelationalTable) => SQL }
}>

/**
 * The sort keys and tiebreak against the queried table; a sort field it lacks is a wiring mistake,
 * `sort_not_wired` as buildListQuery answers it (QL11 of r22b). A table with no `id` has no tiebreak,
 * which listOptions needs on every request, so it is refused by its own cause, keyed as buildListQuery
 * keys a cursor over it
 */
function keysOn(table: RelationalTable, sort: readonly SortField[]): { keys: SortKey[]; tiebreak: SortKey } {
	const column = (field: string): SQLWrapper => {
		if (Object.hasOwn(table, field)) return (table as Record<string, SQLWrapper>)[field] as SQLWrapper
		throw new CombError({
			cause: `Sort on '${field}' has no column to run it`,
			errorKey: combErrorKeys.SORT_NOT_WIRED,
			status: "internal_server_error",
		})
	}
	const keys = sort.map(({ direction, field, nulls }) => ({ column: column(field), direction, nulls }))
	if (!Object.hasOwn(table, CURSOR_TIEBREAK_COLUMN))
		throw new CombError({
			cause: "listOptions breaks ties on the table's `id` column, which this table lacks",
			errorKey: combErrorKeys.CURSOR_PAGINATION_UNSUPPORTED,
			status: "internal_server_error",
		})
	return { keys, tiebreak: { column: column(CURSOR_TIEBREAK_COLUMN), direction: sort[0]?.direction ?? "desc" } }
}

/**
 * Refuse a computed sort where the options are built, not lazily in `orderBy`: the relational
 * API orders by the table's columns alone, and no table is needed to know it (QL11 of r22b)
 */
function refuseComputed(sort: readonly SortField[]): void {
	const computed = sort.find(({ field }) => field.startsWith("@"))
	if (computed === undefined) return
	throw new CombError({
		cause: `Sort on '${computed.field}' is computed, which the relational listOptions cannot order by: use buildListQuery`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})
}

/** The id a cursor resumes from: the tiebreak itself, decoded as its column decodes (Q2 of r17) */
function tiebreakOf(table: RelationalTable): SQL {
	/* drizzle's relational callbacks hand over the table's columns, each a decoder */
	const column = keysOn(table, []).tiebreak.column as Column
	return sql`${column}`.mapWith(column)
}

/** An offset page's count of every row the filter matches, which paginate reports */
const countOver = (): SQL<number> => sql<number>`cast(count(*) over() as integer)`

/**
 * limit, offset, order and the cursor predicate for drizzle's relational `findMany`, from the
 * list query schema's output, the cursor opened under `options`: the app's secret and the list's
 * scope. The limit is one over the page so `paginate` can tell there is more.
 */
function drizzleListOptions(query: ListQueryInput, options: CursorOptions): DrizzleListOptions {
	assertSchemaParsed(query)
	assertLimitWithin(query)
	/* options that cannot seal are a wiring mistake on page 1 too, not only once a cursor comes back */
	assertCursorWired(options)
	const sort = query.parsedSort
	refuseComputed(sort)
	const orderBy = (table: RelationalTable) => {
		const { keys, tiebreak } = keysOn(table, sort)
		return orderByKeys(keys, tiebreak)
	}
	/* every row carries what paginate reads, and a page whose rows do not is refused (Q3); the return checks `extras` */
	/* a key whose read rounds it carries its text, which the next cursor binds (QL3 of r22b) */
	const texts =
		sort.length === 0
			? {}
			: { _combKeyTexts: (table: RelationalTable) => keyTextsSQL(keysOn(table, sort).keys, "postgres") }
	const base = <E extends object>(given: E) => {
		const extras = { ...given, ...texts }
		return {
			extras,
			limit: query.limit + 1,
			orderBy,
			pagination: paginationOf(options, {
				cursorable: true,
				expects: Object.keys(extras) as ListExtra[],
				query,
				window: query.limit + 1,
			}),
		}
	}
	if (!query.cursor) {
		/* a page no schema bounded is bounded here, as buildListQuery bounds it (U5) */
		assertPageWithin(query)
		return { ...base({ _combId: tiebreakOf, _total: countOver }), offset: ((query.page ?? 1) - 1) * query.limit }
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
			cursor.values.map((value, i) =>
				bindableOn(keys[i]?.column, boundCarried(keys[i]?.column, value, cursor.carried[i] ?? false)),
			),
			{ id, nonFinite: options.nonFinite, table, tiebreak: tiebreak.column },
		)
		return { id, keys, tiebreak, values }
	}
	const where = (table: RelationalTable) => keysetSQL(positionOn(table))
	if (!cursor.values.some((value) => value instanceof CursorRef))
		return { ...base({ _combId: tiebreakOf }), offset: 0, where: { RAW: where } }
	/* a reference may have no safe bound once its row is gone: the flag tells paginate, which has no database */
	const gone = (table: RelationalTable) => sql<number>`${anchorGone(positionOn(table).values) ?? sql`0`}`
	return { ...base({ _combAnchorGone: gone, _combId: tiebreakOf }), offset: 0, where: { RAW: where } }
}

function drizzleProject<T extends Record<string, unknown>>(row: T, parsedFields: ParsedFields | null): T {
	return applySelect(row, parsedFields)
}

/** List-query helpers for drizzle queries: options, pagination, projection */
const queryHelpers: {
	filterValue: typeof extractFilterValue
	filterValues: typeof extractFilterValues
	listOptions: typeof drizzleListOptions
	paginate: typeof paginate
	project: typeof drizzleProject
} = {
	filterValue: extractFilterValue,
	filterValues: extractFilterValues,
	listOptions: drizzleListOptions,
	paginate,
	project: drizzleProject,
}

export { type CursorOptions, drizzleListOptions, type DrizzleListOptions, drizzleProject, queryHelpers }
