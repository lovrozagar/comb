/**
 * Drizzle relational query helpers — thin abstraction for using
 * query-helpers with drizzle's relational query API.
 */
import type { Column, SQL, SQLWrapper } from "drizzle-orm"
import { is, sql } from "drizzle-orm"
import { SQLiteColumn } from "drizzle-orm/sqlite-core"

import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"

import { type CursorId, CursorRef, CURSOR_TIEBREAK_COLUMN, readKeyset } from "./cursor.ts"
import type { ColumnCheck } from "./cursor-mint.ts"
import { anchored } from "./cursor-ref.ts"
import { assertCursorWired, type CursorOptions } from "./cursor-seal.ts"
import { assertCursorFits, bindableOn, boundCarried, unfitIndex } from "./sqlite/cursor-fit.ts"
import { extractFilterValue, extractFilterValues } from "./filter-values.ts"
import { anchorGone, keysetSQL, orderByKeys, type SortKey } from "./sqlite/keyset.ts"
import { keyTextsSQL, textKeysSQL } from "./sqlite/key-texts.ts"
import { applySelect, type ListExtra, type ListPagination, paginate, paginationOf } from "./pagination.ts"
import { assertLimitWithin, assertPageWithin, assertSchemaParsed } from "./trusted.ts"
import type { ListQueryInput, ParsedFields, SortField } from "./types.ts"

/** A table as drizzle's relational callbacks hand it over, holding its columns as own properties */
export type RelationalTable = object

/**
 * What drizzle's relational `findMany` reads one list page with: spread `limit`, `offset`, `orderBy`
 * and `extras` into it, AND `where` with your own, and hand the rows to `paginate` with these options
 */
type DrizzleListOptions = {
	/** one over the page's limit, so `paginate` can tell there is a next page */
	limit: number
	/** the rows before the page; 0 on a cursor request, which resumes by `where` */
	offset: number
	/** The sort, its null placement and the id tiebreak, for `findMany({ orderBy })` */
	orderBy: (table: RelationalTable) => SQL[]
	// Q3 of r17, Q2, U26
	/**
	 * For `findMany({ extras })`: the columns `paginate` reads from each row, and refuses a page
	 * without. `project` strips them from the rows it returns
	 */
	extras: {
		/** the row's `id`, which the next cursor resumes from */
		_combId: (table: RelationalTable) => SQL
	} & Partial<{
		/** on a cursor whose row may be gone: 1 when it is, which `paginate` answers with a 400 asking to start again */
		_combAnchorGone: (table: RelationalTable) => SQL<number>
		// QL3 of r22b
		/** each sort key's stored text where reading it back rounds it; on every list with a sort */
		_combKeyTexts: (table: RelationalTable) => SQL<string>
		// B2-3 of area B
		/** each SQLite timestamp sort key's stored TEXT, which the next cursor binds as stored; on every list with a sort */
		_combTextKeys: (table: RelationalTable) => SQL<string>
		/** on a page read by number: every row the filter matches, which `paginate` reports as the count */
		_total: (table: RelationalTable) => SQL<number>
	}>
	/** How `paginate` pages the rows these options read */
	pagination: ListPagination & {
		/** always false: these options read one database, which `paginate` pages */
		merged: false
	}
} & Partial<{
	/** The keyset predicate of a cursor request, for `findMany({ where })` (AND it with your own) */
	where: {
		/** the predicate on the queried table, for drizzle to inline as raw SQL */
		RAW: (table: RelationalTable) => SQL
	}
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

// AB4-1 of area B
/**
 * The `_combId` extra, which notes the table drizzle reads the rows from, as it hands it to every query's
 * callbacks, and the check positionOn opens the next cursor by, run on that table's columns, so the next
 * page never refuses a cursor minted here; rows no query of these options read hold no column to check
 */
function checkedOn(sort: readonly SortField[]): { holds: ColumnCheck; idOf: (table: RelationalTable) => SQL } {
	let readFrom: RelationalTable | undefined
	return {
		holds: (values, carried) => {
			if (readFrom === undefined) return -1
			const { keys, tiebreak } = keysOn(readFrom, sort)
			return unfitIndex([...keys.map(({ column }) => column), tiebreak.column], values, { carried })
		},
		idOf: (table) => {
			readFrom = table
			return tiebreakOf(table)
		},
	}
}

/** An offset page's count of every row the filter matches, which paginate reports */
const countOver = (): SQL<number> => sql<number>`cast(count(*) over() as integer)`

/**
 * The extras that carry a key's text where its read rounds it or loses its time, and a SQLite
 * timestamp's TEXT, which the next cursor binds (QL3 of r22b, B2-3 and AB3-4 of area B), in the
 * dialect the table's columns are of; none on a list with no sort
 */
function textsOf(sort: readonly SortField[]) {
	if (sort.length === 0) return {}
	const keyTexts = (table: RelationalTable) => {
		const { keys, tiebreak } = keysOn(table, sort)
		return keyTextsSQL(keys, is(tiebreak.column, SQLiteColumn) ? "sqlite" : "postgres")
	}
	return {
		_combKeyTexts: keyTexts,
		_combTextKeys: (table: RelationalTable) => textKeysSQL(keysOn(table, sort).keys),
	}
}

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
	const texts = textsOf(sort)
	const { holds, idOf } = checkedOn(sort)
	const base = <E extends object>(given: E) => {
		const extras = { ...given, ...texts }
		return {
			extras,
			limit: query.limit + 1,
			orderBy,
			pagination: paginationOf(options, {
				cursorable: true,
				expects: Object.keys(extras) as ListExtra[],
				holds,
				query,
				window: query.limit + 1,
			}),
		}
	}
	if (!query.cursor) {
		/* a page no schema bounded is bounded here, as buildListQuery bounds it (U5) */
		assertPageWithin(query)
		return { ...base({ _combId: idOf, _total: countOver }), offset: ((query.page ?? 1) - 1) * query.limit }
	}
	const cursor = readKeyset(query.cursor, sort, options)
	const positionOn = (table: RelationalTable) => {
		const { keys, tiebreak } = keysOn(table, sort)
		/* the cursor is client input: each value must be what its column holds, or it is a 400 */
		assertCursorFits([...keys.map(({ column }) => column), tiebreak.column], [...cursor.values, cursor.id], {
			carried: (i) => cursor.carried[i] === true,
		})
		const id = bindableOn(tiebreak.column, cursor.id) as CursorId
		/* a value the keyset reads from the row is anchored; the others bind as their keys compare them */
		const values = anchored(
			keys,
			cursor.values.map((value, i) =>
				bindableOn(keys[i]?.column, boundCarried(keys[i]?.column, value, cursor.carried[i] === true)),
			),
			{ id, nonFinite: options.nonFinite, table, tiebreak: tiebreak.column },
		)
		return { id, keys, tiebreak, values }
	}
	const where = (table: RelationalTable) => keysetSQL(positionOn(table))
	if (!cursor.values.some((value) => value instanceof CursorRef))
		return { ...base({ _combId: idOf }), offset: 0, where: { RAW: where } }
	/* a reference may have no safe bound once its row is gone: the flag tells paginate, which has no database */
	const gone = (table: RelationalTable) => sql<number>`${anchorGone(positionOn(table).values) ?? sql`0`}`
	return { ...base({ _combAnchorGone: gone, _combId: idOf }), offset: 0, where: { RAW: where } }
}

/** `row` with only the fields `select` asked for, and none of the list's own extras; every field when `parsedFields` is null */
function drizzleProject<T extends Record<string, unknown>>(row: T, parsedFields: ParsedFields | null): T {
	return applySelect(row, parsedFields)
}

/** List-query helpers for drizzle queries: options, pagination, projection */
const queryHelpers: {
	/** the value the filter holds every row's field to, as `extractFilterValue` reads it */
	filterValue: typeof extractFilterValue
	/** the values the filter holds every row's fields to, as `extractFilterValues` reads them */
	filterValues: typeof extractFilterValues
	/** the `findMany` options of a list page, as `drizzleListOptions` builds them */
	listOptions: typeof drizzleListOptions
	/** the page and its pagination from the rows `listOptions` read */
	paginate: typeof paginate
	/** a row cut to its `select`, as `drizzleProject` cuts it */
	project: typeof drizzleProject
} = {
	filterValue: extractFilterValue,
	filterValues: extractFilterValues,
	listOptions: drizzleListOptions,
	paginate,
	project: drizzleProject,
}

export { type CursorOptions, drizzleListOptions, type DrizzleListOptions, drizzleProject, queryHelpers }
