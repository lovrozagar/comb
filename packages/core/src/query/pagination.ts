/**
 * How a built list pages what it fetched (Q6, C3, C19, C2 of the 0.14.1 review). Each builder
 * (`buildListQuery`, `buildDerivedListQuery`, `queryHelpers.listOptions`, `mergedListOptions`)
 * hands over a `pagination` descriptor: the page it read, whether a cursor can resume it, how a
 * long key is carried, and how many rows it asked for. `paginate` reads it, so nothing about the
 * list is told twice. The cursor secret is never a value of it: the descriptor seals and opens
 * cursors through closures over the options its builder was given, so logging or serializing a
 * built query shows no part of the secret.
 */
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import { CURSOR_TIEBREAK_COLUMN, type DecodedCursor, readCursor } from "./cursor.ts"
import { createCursor, type KeysetKind } from "./cursor-mint.ts"
import { assertCursorWired, type CursorOptions } from "./cursor-seal.ts"
import { filterBySelect } from "./fields.ts"
import type { paginationResponseSchema } from "./schema.ts"
import type { ParsedFields, SortField } from "./types.ts"
import type * as z from "zod"

/** The pagination meta paginate returns: the list response's own schema */
type PaginationMeta = z.output<typeof paginationResponseSchema>

/** How a built list pages what it fetched */
type ListPagination = {
	/** the cursor the request resumed from; none on a page by number */
	cursor: string | undefined
	/** false when no cursor can resume the list: its order holds a computed sort, or it has no tiebreak (Q6) */
	cursorable: boolean
	cursorScope: string
	/** the field a row's tiebreak id is in */
	idField: string
	/** how a key too long for a cursor is carried: by reference to its row ("table"), or not at all ("derived") */
	keyset: KeysetKind
	limit: number
	nonFinite: "exact" | undefined
	page: number | undefined
	parsedFields: ParsedFields | null
	parsedSort: SortField[]
	/** the most rows the built query reads: one past the page, so paginate can tell there is more */
	window: number
	/** the cursor for the page after `row`, sealed under the builder's options */
	mint(row: object): string
	/** `cursor` opened under the builder's options, for this list's sort; a 400 when it is no cursor of it */
	read(cursor: string): DecodedCursor
}

/** What a builder knows of its list, beside the request it parsed */
type PaginationFacts = {
	/** the sort fields whose keys read a reference back from the list's table (readsBack); every one when not given */
	byReference?: ReadonlySet<string> | undefined
	cursorable: boolean
	idField?: string | undefined
	keyset?: KeysetKind | undefined
	query: {
		cursor?: string | null | undefined
		limit: number
		page?: number | null | undefined
		parsedFields?: ParsedFields | null | undefined
		parsedSort: SortField[]
	}
	window: number
}

/** The descriptor a builder hands over: its facts, and the options it seals under closed over, never held */
function paginationOf(options: CursorOptions, facts: PaginationFacts): ListPagination {
	assertCursorWired(options)
	const { query } = facts
	const idField = facts.idField ?? CURSOR_TIEBREAK_COLUMN
	const keyset = facts.keyset ?? "table"
	return {
		cursor: query.cursor || undefined,
		cursorable: facts.cursorable,
		cursorScope: options.cursorScope,
		idField,
		keyset,
		limit: query.limit,
		mint: (row) => mintFrom(row, query.parsedSort, { ...options, byReference: facts.byReference, idField, keyset }),
		nonFinite: options.nonFinite,
		page: query.page ?? undefined,
		parsedFields: query.parsedFields ?? null,
		parsedSort: query.parsedSort,
		read: (cursor) => readCursor(cursor, query.parsedSort, options),
		window: facts.window,
	}
}

/**
 * Rows the filter matches across all pages, or null when this page cannot know: a cursor page
 * (no count was selected), a page past the end (no row carried it), or a query without countExtra.
 */
function countOf(items: ReadonlyArray<{ _total?: number }>, pagination: ListPagination): number | null {
	if (pagination.cursor) return null
	const first = items[0]
	if (first === undefined) return (pagination.page ?? 1) === 1 ? 0 : null
	return first._total ?? null
}

/** Read before anything else, _total included: a list past a gone anchor is no page of it (U26) */
function refuseGoneAnchor(items: readonly object[]): void {
	if (items.some((item) => Number((item as Record<string, unknown>)["_combAnchorGone"]) === 1)) {
		throw new CombError({
			cause:
				"the row this cursor resumes from was renamed or deleted, and no bound is safe under its collation; start the list again",
			errorKey: combErrorKeys.INVALID_CURSOR,
			status: "bad_request",
		})
	}
}

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
function mintFrom(
	row: object,
	parsedSort: SortField[],
	options: CursorOptions & { byReference?: ReadonlySet<string> | undefined; idField: string; keyset: KeysetKind },
): string {
	const missing = [...parsedSort.map(({ field }) => field), options.idField].filter((key) => !Object.hasOwn(row, key))
	if (missing.length > 0) {
		throw new CombError({
			cause: `paginate mints the next cursor from each row's ${missing.join(", ")}; select them`,
			errorKey: combErrorKeys.SORT_NOT_WIRED,
			status: "internal_server_error",
		})
	}
	/* a key too long for the cap goes by reference; a derived list, which cannot read it, says so on page 1 */
	return createCursor(row as Record<string, unknown>, parsedSort, options)
}

/** `built` as paginate takes it, or a 500 naming the call: a parsed query in its place is the call before 0.15 */
function paginationIn(built: { pagination: ListPagination } | undefined): ListPagination {
	const pagination = (built as { pagination?: ListPagination } | undefined)?.pagination
	if (pagination !== undefined) return pagination
	throw new CombError({
		cause:
			"paginate takes the built query (buildListQuery, buildDerivedListQuery, queryHelpers.listOptions or mergedListOptions) in place of the parsed query and cursor options it took before 0.15",
		errorKey: combErrorKeys.PAGE_NOT_WIRED,
		status: "internal_server_error",
	})
}

/** More rows than the built query reads are rows of another query: one that applied no limit (C2) */
function refuseOverRead(count: number, pagination: ListPagination): void {
	if (count <= pagination.window) return
	throw new CombError({
		cause: `paginate got ${count} rows where the built query reads at most ${pagination.window}: apply its limit and offset (applyListQuery does)`,
		errorKey: combErrorKeys.PAGE_NOT_WIRED,
		status: "internal_server_error",
	})
}

/**
 * The page of `items`, read with `built`, and its pagination: count, whether there is more, and
 * the next cursor, sealed under the builder's options; none for a list no cursor can resume
 */
function paginate<T extends object>(
	items: ReadonlyArray<T & { _total?: number }>,
	built: { pagination: ListPagination },
): readonly [T[], PaginationMeta] {
	const pagination = paginationIn(built)
	refuseOverRead(items.length, pagination)
	refuseGoneAnchor(items)
	const hasMore = items.length > pagination.limit
	const sliced = hasMore ? items.slice(0, pagination.limit) : items
	/* minted from the fat row, under the sort the builder ordered by, so the next request's signature matches */
	const last = sliced.at(-1)
	const meta: PaginationMeta = {
		count: countOf(items, pagination),
		hasMore,
		limit: pagination.limit,
		nextCursor: hasMore && pagination.cursorable && last !== undefined ? pagination.mint(last) : null,
		page: pagination.cursor ? null : (pagination.page ?? 1),
	}
	/* projected after the slice, so count, hasMore and the cursor still see the fat row */
	const page = sliced.map((item) => applySelect(item as T & Record<string, unknown>, pagination.parsedFields))
	return [page, meta] as const
}

export {
	applySelect,
	type ListPagination,
	paginate,
	type PaginationFacts,
	type PaginationMeta,
	paginationOf,
	paginationIn,
	refuseGoneAnchor,
	refuseOverRead,
}
