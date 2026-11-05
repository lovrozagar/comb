/**
 * How a built list pages what it fetched (Q6, C3, C19, C2 of the 0.14.1 review). Each builder
 * (`buildListQuery`, its `merged` list included, `buildDerivedListQuery`, `queryHelpers.listOptions`)
 * hands over a `pagination` descriptor: the page it read, whether a cursor can resume it, how a
 * long key is carried, and how many rows it asked for. `paginate` reads it, so nothing about the
 * list is told twice. The cursor secret is never a value of it: the descriptor seals and opens
 * cursors through closures over the options its builder was given, so logging or serializing a
 * built query shows no part of the secret.
 */
import { type DecodedCursor, readKeyset } from "./cursor.ts"
import { fitCursor, type KeysetKind } from "./cursor-mint.ts"
import { assertCursorWired, type CursorOptions } from "./cursor-seal.ts"
import { carriedTexts, COMB_ID, typedKeys } from "./list-extras.ts"
import { filterBySelect } from "./fields.ts"
import { paginationIn, refuseGoneAnchor, refuseOverRead, refuseUnwired } from "./page-refusals.ts"
import type { paginationResponseSchema } from "./schema.ts"
import type { ListQueryInput, ParsedFields, SortField } from "./types.ts"
import type * as z from "zod"

/**
 * One column a builder selects for paginate: the tiebreak, the gone-anchor flag, the count (Q3 of
 * r17), or the class of each sort key (Q2 of r19, Q2 of r21)
 */
type ListExtra = "_combAnchorGone" | "_combId" | "_combKeyTexts" | "_combKeyTypes" | "_combTextKeys" | "_total"

/**
 * A row as paginate and paginateMerged return it: the extras gone, from each member of a union
 * row type on its own, so narrowing on its discriminant still reaches each variant's fields (Q3 of r19)
 */
type ListRow<T> = T extends unknown ? Omit<T, ListExtra> : never

/** The columns a builder selects for paginate alone, stripped from every row it returns */
const EXTRAS: readonly ListExtra[] = [
	COMB_ID,
	"_combAnchorGone",
	"_combKeyTexts",
	"_combKeyTypes",
	"_combTextKeys",
	"_total",
]

/** The pagination meta paginate returns: the list response's own schema */
type PaginationResponse = z.output<typeof paginationResponseSchema>

/** How a built list pages what it fetched */
type ListPagination = {
	/** the cursor the request resumed from; none on a page by number */
	cursor: string | undefined
	/** false when no cursor can resume the list: its order holds a computed sort, or it has no tiebreak (Q6) */
	cursorable: boolean
	cursorScope: string
	/** the extras the builder selected, which every row it reads must carry (Q3) */
	expects: readonly ListExtra[]
	/** how a key too long for a cursor is carried: by reference to its row ("table"), or not at all ("derived") */
	keyset: KeysetKind
	limit: number
	/** read through buildListQuery's `merged`: paged by paginateMerged, never by paginate (K8 of r17) */
	merged: boolean
	nonFinite: "exact" | undefined
	page: number | undefined
	parsedFields: ParsedFields | null
	parsedSort: readonly SortField[]
	/** the most rows the built query reads: one past the page, so paginate can tell there is more */
	window: number
	/** the cursor for the page after `row`, sealed under the builder's options */
	mint(row: object): string
	/** `cursor` opened under the builder's options, for this list's sort; a 400 when it is no cursor of it */
	read(cursor: string): DecodedCursor
}

/** What a builder knows of its list, beside the request it parsed */
type PaginationFacts = {
	/** the sort fields whose keys the list binds as read, with no row to read a bound from (QL1 of r22b); every one on a derived list */
	asRead?: ReadonlySet<string> | undefined
	/** the sort fields whose keys read a reference back from the list's table (readsBack); every one when not given */
	byReference?: ReadonlySet<string> | undefined
	cursorable: boolean
	/** the extras the builder selected, which every row must carry */
	expects: readonly ListExtra[]
	keyset?: KeysetKind | undefined
	query: ListQueryInput
	window: number
}

/** The descriptor a builder hands over: its facts, and the options it seals under closed over, never held */
function paginationOf<TMerged extends boolean = false>(
	options: CursorOptions,
	facts: PaginationFacts & { merged?: TMerged | undefined },
): ListPagination & { merged: TMerged } {
	assertCursorWired(options)
	const { query } = facts
	const keyset = facts.keyset ?? "table"
	return {
		cursor: query.cursor || undefined,
		cursorable: facts.cursorable,
		cursorScope: options.cursorScope,
		expects: facts.expects,
		keyset,
		limit: query.limit,
		merged: (facts.merged ?? false) as TMerged,
		mint: (row) =>
			mintFrom(row, query.parsedSort, { ...options, asRead: facts.asRead, byReference: facts.byReference, keyset }),
		nonFinite: options.nonFinite,
		page: query.page ?? undefined,
		parsedFields: query.parsedFields ?? null,
		parsedSort: query.parsedSort,
		read: (cursor) => readKeyset(cursor, query.parsedSort, options),
		window: facts.window,
	}
}

/** The count an offset page's row carries, in any encoding isCount takes, which refuseUnwired holds every such row to */
const totalOf = (row: object): number => Number((row as { _total: bigint | number | string })._total)

/**
 * Rows the filter matches across all pages, or null when this page cannot know: a cursor page
 * (no count was selected), or a page past the end (no row carried it).
 */
function countOf(items: readonly object[], pagination: ListPagination): number | null {
	if (pagination.cursor) return null
	const first = items[0]
	if (first === undefined) return (pagination.page ?? 1) === 1 ? 0 : null
	return totalOf(first)
}

/** The builder's extras are never public fields: callers read pagination.count and nextCursor */
function stripExtras<T extends Record<string, unknown>>(row: T): T {
	if (!EXTRAS.some((key) => Object.hasOwn(row, key))) return row
	const rest = { ...row }
	for (const key of EXTRAS) delete rest[key]
	return rest
}

/**
 * Last mutation of item shape. Query stays fat; the returned object is the
 * public subset. No-op (minus `_total`) when parsedFields is null.
 */
function applySelect<T extends Record<string, unknown>>(row: T, parsedFields: ParsedFields | null): T {
	const publicRow = stripExtras(row)
	if (!parsedFields) return publicRow
	return filterBySelect(publicRow, parsedFields) as T
}

/**
 * The next cursor, minted from the last row of the page: its sort keys, and the tiebreak the
 * builder selected as `_combId`. A row without one would mint a cursor that repeats or ends the
 * list, a wiring mistake mintCursor refuses (QL5 of r22b). Any id, 0 and "" included, carries the next page.
 */
function mintFrom(
	row: object,
	parsedSort: readonly SortField[],
	options: CursorOptions & {
		asRead?: ReadonlySet<string> | undefined
		byReference?: ReadonlySet<string> | undefined
		keyset: KeysetKind
	},
): string {
	/* a key too long for the cap goes by reference; a derived list, which cannot read it, says so on page 1 */
	const read = row as Record<string, unknown>
	return fitCursor(typedKeys(read, parsedSort), parsedSort, {
		...options,
		carried: carriedTexts(read, parsedSort),
		idField: COMB_ID,
		read,
	})
}

/**
 * The page of `items`, read with `built`, and its pagination: count, whether there is more, and
 * the next cursor, sealed under the builder's options; none for a list no cursor can resume
 */
function paginate<T extends object>(
	items: readonly T[],
	built: { pagination: ListPagination & { merged: false } },
): readonly [Array<ListRow<T>>, PaginationResponse] {
	const pagination = paginationIn(built, false)
	refuseOverRead(items.length, pagination)
	refuseUnwired(items, pagination)
	refuseGoneAnchor(items)
	const hasMore = items.length > pagination.limit
	const sliced = hasMore ? items.slice(0, pagination.limit) : items
	/* minted from the fat row, under the sort the builder ordered by, so the next request's signature matches */
	const last = sliced.at(-1)
	const meta: PaginationResponse = {
		count: countOf(items, pagination),
		hasMore,
		limit: pagination.limit,
		nextCursor: hasMore && pagination.cursorable && last !== undefined ? pagination.mint(last) : null,
		page: pagination.cursor ? null : (pagination.page ?? 1),
	}
	/* projected after the slice, so count, hasMore and the cursor still see the fat row */
	const page = sliced.map((item) => applySelect(item as T & Record<string, unknown>, pagination.parsedFields))
	/* the extras are stripped, so the rows are typed without them (Q15 of r18) */
	return [page as unknown as Array<ListRow<T>>, meta] as const
}

export {
	applySelect,
	COMB_ID,
	type ListExtra,
	type ListPagination,
	type ListRow,
	paginate,
	type PaginationFacts,
	type PaginationResponse,
	paginationOf,
	totalOf,
}
