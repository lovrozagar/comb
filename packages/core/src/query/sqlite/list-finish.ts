/**
 * The shared tail of the SQLite list builders (build-list-query.ts): the cursor predicate, the page
 * window, the extras every row carries for paginate, and the pagination descriptor that reads them.
 */
import { and, Column, is, type SQL, type SQLWrapper, sql } from "drizzle-orm"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"
import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"
import type { CursorOptions } from "../cursor.ts"
import { assertCursorWired } from "../cursor-seal.ts"
import { COMB_ID, type ListExtra, type ListPagination, type PaginationFacts, paginationOf } from "../pagination.ts"
import { assertLimitWithin, assertPageWithin } from "../trusted.ts"
import type { ListQueryInput, SortField } from "../types.ts"
import type { ListExtras, ListQueryResult } from "./build-list-query-types.ts"
import { readsBack } from "./cursor-fit.ts"
import { cursorWhere } from "./cursor-where.ts"
import type { SortKey } from "./keyset.ts"

type Keyset = {
	/** Present only when every key is a real column a predicate can compare. */
	keys: SortKey[] | null
	orderBy: SQL[]
}

type Finish = {
	cursor: CursorOptions
	/** a list every shard reads, merged by paginateMerged (K5 of r17) */
	merged?: { maxRowsPerShard?: number | undefined } | undefined
	/** the table a cursor's references are read from; none on a derived list */
	table?: SQLiteTable | undefined
	keyset: Keyset
	parsed: ListQueryInput
	sort: readonly SortField[]
	/** null when the table has no tiebreak column, so no cursor can be honored */
	tiebreak: SortKey | null
	where: Array<SQL | null | undefined>
}

/** A built list before its pagination is told merged or not: buildListQuery's overloads tell it */
type Finished = Omit<ListQueryResult, "pagination"> & { pagination: ListPagination }

/* the rows a merged page may read from each shard by default: page × limit + 1, as deep as page 10 at 100 */
const MAX_ROWS_PER_SHARD = 1001

function combineWhere(...clauses: (SQL | null | undefined)[]): SQL | undefined {
	const valid = clauses.filter((c): c is SQL => c !== null && c !== undefined)
	if (valid.length === 0) return undefined
	if (valid.length === 1) return valid[0]
	return and(...valid)
}

/** The tiebreak, selected as the id the next cursor is minted from, decoded as its column decodes */
function combId(tiebreak: SQLWrapper): SQL.Aliased<unknown> {
	const value = sql`${tiebreak}`
	return (is(tiebreak, Column) ? value.mapWith(tiebreak) : value).as(COMB_ID)
}

/**
 * The rows each shard of a merged list reads by page number: from the list's first row to the
 * page's end and one more, as any shard may hold any of them; past `maxRowsPerShard` a 400
 */
function shardWindow(parsed: ListQueryInput, merged: { maxRowsPerShard?: number | undefined }): number {
	const rows = (parsed.page ?? 1) * parsed.limit + 1
	const max = merged.maxRowsPerShard ?? MAX_ROWS_PER_SHARD
	if (rows <= max) return rows
	throw new CombError({
		cause: `A merged list reads every row up to the page's end from each shard, ${rows} here, past ${max}; page by cursor instead`,
		errorKey: combErrorKeys.PAGE_TOO_DEEP,
		status: "bad_request",
	})
}

/** What paginate is told of the list, beside the extras its rows carry */
function factsOf({ keyset, merged, parsed, sort, table, tiebreak }: Finish) {
	return {
		/* a computed sort, or no tiebreak, leaves nothing a cursor can resume from: the list pages by number (Q6) */
		cursorable: keyset.keys !== null && tiebreak !== null,
		/* a merged list's anchor row is on one shard only, so it never pages by reference (Q1 of r17) */
		keyset: merged !== undefined ? "merged" : table === undefined ? "derived" : "table",
		/* the sort fields a reference reads back on, by the rule the cursor's read holds (27.7) */
		byReference: new Set(
			(keyset.keys ?? []).flatMap(({ column }, i) => (readsBack(column, table) ? [sort[i]?.field as string] : [])),
		),
		merged: merged !== undefined,
		query: parsed,
		window: parsed.limit + 1,
	} satisfies Omit<PaginationFacts, "expects"> & { merged: boolean }
}

/** The built list over `extras`: every row carries what paginate reads, and a page whose rows do not is refused (Q3) */
function withExtras(list: Finish, extras: ListExtras, window = list.parsed.limit + 1) {
	const facts = { ...factsOf(list), expects: Object.keys(extras) as ListExtra[], window }
	return { extras, pagination: paginationOf(list.cursor, facts) }
}

/* the id a cursor resumes from is the tiebreak itself, so no row's own id can stand in for it (Q2) */
const idOf = (tiebreak: SortKey | null): ListExtras => (tiebreak === null ? {} : { _combId: combId(tiebreak.column) })

/** A cursor page: the rows past the cursor and one more, and the flag that says its anchor is gone */
function finishCursor(list: Finish, cursor: string): Finished {
	const { keyset, parsed, sort, table, tiebreak } = list
	if (!keyset.keys || !tiebreak) {
		throw new CombError({
			cause: "Cursor pagination needs every sort key to be a column; use page instead",
			errorKey: combErrorKeys.CURSOR_PAGINATION_UNSUPPORTED,
			status: "bad_request",
		})
	}
	const merged = list.merged !== undefined
	const after = cursorWhere({ cursor, keys: keyset.keys, merged, options: list.cursor, sort, table, tiebreak })
	const gone = after.gone === undefined ? {} : { _combAnchorGone: sql<number>`${after.gone}`.as("_combAnchorGone") }
	return {
		...withExtras(list, { ...idOf(tiebreak), ...gone }),
		limit: parsed.limit + 1,
		meta: { limit: parsed.limit, page: 1, type: "cursor" },
		offset: 0,
		orderBy: keyset.orderBy,
		search: parsed.q?.trim() || null,
		where: combineWhere(...list.where, after.where),
	}
}

/** A page by number, counted; a merged list's shards each read every row before its end */
function finishOffset(list: Finish): Finished {
	const { keyset, merged, parsed, tiebreak } = list
	assertPageWithin(parsed)
	const page = parsed.page ?? 1
	const total = { _total: sql<number>`cast(count(*) over() as integer)`.as("_total") }
	/* each shard reads the merged page's every row before it, and counts its part, which paginateMerged sums */
	const window = merged === undefined ? parsed.limit + 1 : shardWindow(parsed, merged)
	return {
		...withExtras(list, { ...idOf(tiebreak), ...total }, window),
		limit: window,
		meta: { limit: parsed.limit, page, type: "offset" },
		offset: merged === undefined ? (page - 1) * parsed.limit : 0,
		orderBy: keyset.orderBy,
		search: parsed.q?.trim() || null,
		where: combineWhere(...list.where),
	}
}

/**
 * Shared tail of both builders: cursor predicate, pagination mode, result shape.
 * `keys` null means the order includes something keyset cannot express.
 */
function finish(given: Finish): Finished {
	assertCursorWired(given.cursor)
	assertLimitWithin(given.parsed)
	return given.parsed.cursor ? finishCursor(given, given.parsed.cursor) : finishOffset(given)
}

export { finish, type Keyset }
