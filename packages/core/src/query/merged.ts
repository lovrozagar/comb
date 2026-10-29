/**
 * A list whose rows sit on several D1 shards, merged in memory (L2 of the 0.13.0 consumers review).
 * Each shard reads its part through `mergedListOptions`: past the cursor, the page's rows and one
 * more, as `listOptions` reads them; by page number, every row up to the page's end, as any shard
 * may hold any of them. `paginateMerged` then orders the merge as SQLite's ORDER BY does, windows
 * it as the request asks, counts what every shard counted, and mints the next cursor from the
 * page's last row, so the merged list pages as one database's would, by number or by cursor.
 */
import { type SQL, sql } from "drizzle-orm"
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import { CURSOR_TIEBREAK_COLUMN, CursorRef, effectiveNulls, readCursor } from "./cursor.ts"
import type { CursorOptions } from "./cursor-seal.ts"
import {
	applySelect,
	type DrizzleListOptions,
	mintFrom,
	type PaginateOptions,
	queryHelpers,
	refuseGoneAnchor,
} from "./drizzle.ts"
import type { paginationResponseSchema } from "./schema.ts"
import type { ParsedFields, SortField } from "./types.ts"
import type * as z from "zod"

/* the rows a merged page may read from each shard by default: page × limit + 1, as deep as page 10 at 100 */
const MAX_ROWS_PER_SHARD = 1001

type MergedQuery = Parameters<typeof queryHelpers.listOptions>[0]

/** listOptions for one shard: its extras may carry the shard's count beside the gone-anchor flag */
type MergedListOptions = Omit<DrizzleListOptions, "extras"> & { extras?: Record<string, (table: object) => SQL> }

/**
 * `listOptions` for one shard of a merged list: a cursor page as `listOptions` reads it, an offset
 * page from the list's first row to the page's last and one more, each row carrying the shard's
 * count, so no countExtra is needed. A page whose window passes
 * `maxRowsPerShard` (1001 by default) is `page_too_deep`: every shard would read every row before it
 */
function mergedListOptions(
	query: MergedQuery,
	options: CursorOptions & { maxRowsPerShard?: number | undefined },
): MergedListOptions {
	/*
	 * a null anchor is a real NULL (Q1 of the 0.14.1 review): the anchor row is on one shard only, so
	 * every other reads it as gone, and resuming such a shard at -Infinity would repeat its rows. A
	 * row D1 reads back as null that holds ±Infinity comes back out of its shard's own order, which
	 * refuseUnmergeable refuses
	 */
	const list = queryHelpers.listOptions(query, { ...options, nonFinite: "exact" })
	if (query.cursor) return list
	const rows = (query.page ?? 1) * query.limit + 1
	const max = options.maxRowsPerShard ?? MAX_ROWS_PER_SHARD
	if (rows > max) {
		throw new CombError({
			cause: `A merged list reads every row up to the page's end from each shard, ${rows} here, past ${max}; page by cursor instead`,
			errorKey: combErrorKeys.PAGE_TOO_DEEP,
			status: "bad_request",
		})
	}
	/* every shard counts its part, which paginateMerged sums: a merged count needs them all */
	return { ...list, extras: { _total: () => sql`cast(count(*) over() as integer)` }, limit: rows, offset: 0 }
}

/** The order SQLite's BINARY collation gives two text values: by code point, as their UTF-8 bytes compare */
function byCodePoint(a: string, b: string): number {
	const [left, right] = [a[Symbol.iterator](), b[Symbol.iterator]()]
	for (;;) {
		const [x, y] = [left.next(), right.next()]
		/* the one that ends first, a prefix of the other, sorts first */
		if (x.done === true || y.done === true) return Number(x.done !== true) - Number(y.done !== true)
		const diff = (x.value.codePointAt(0) as number) - (y.value.codePointAt(0) as number)
		if (diff !== 0) return diff
	}
}

/* SQLite's storage classes in its order: a number (a boolean or a date one too) before text before a blob */
const classOf = (value: unknown): number => (typeof value === "string" ? 1 : value instanceof Uint8Array ? 2 : 0)

/** A key's number, as SQLite stores a boolean, a date and a bigint */
const numberOf = (value: unknown): number | bigint =>
	typeof value === "bigint" ? value : value instanceof Date ? value.getTime() : Number(value)

/** Two blobs as SQLite compares them: byte by byte, the shorter first when one begins the other */
function byBytes(a: Uint8Array, b: Uint8Array): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number)
	return a.length - b.length
}

/** Two values of one key, neither null, as SQLite orders them ascending */
function compareValues(a: unknown, b: unknown): number {
	const byClass = classOf(a) - classOf(b)
	if (byClass !== 0) return byClass
	if (typeof a === "string") return byCodePoint(a, b as string)
	if (a instanceof Uint8Array) return byBytes(a, b as Uint8Array)
	const [x, y] = [numberOf(a), numberOf(b)]
	return x < y ? -1 : x > y ? 1 : 0
}

const isNull = (value: unknown) => value === null || value === undefined

/** Two rows in the list's order: each key's direction and null placement, then the id, as orderByKeys orders them */
function compareRows(sort: readonly SortField[], idField: string) {
	return (a: Record<string, unknown>, b: Record<string, unknown>): number => {
		for (const { direction, field, nulls } of sort) {
			const [x, y] = [a[field], b[field]]
			if (isNull(x) && isNull(y)) continue
			const first = effectiveNulls(direction, nulls) === "first"
			if (isNull(x)) return first ? -1 : 1
			if (isNull(y)) return first ? 1 : -1
			const order = compareValues(x, y)
			if (order !== 0) return direction === "asc" ? order : -order
		}
		const order = compareValues(a[idField], b[idField])
		return (sort[0]?.direction ?? "desc") === "asc" ? order : -order
	}
}

/**
 * Each shard's rows come back in its own ORDER BY; one out of the merge's order proves a sort key
 * that SQLite does not order BINARY (a column declared COLLATE NOCASE or RTRIM, which drizzle never
 * declares), and a merge by code point would page it wrong. A disagreement only rows on different
 * shards would show is past seeing here, which is why a merged list's sort keys must be BINARY.
 */
function refuseUnmergeable(
	rowsPerShard: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
	compare: ReturnType<typeof compareRows>,
): void {
	for (const [shard, rows] of rowsPerShard.entries()) {
		const at = rows.findIndex((row, i) => i > 0 && compare(rows[i - 1] as Record<string, unknown>, row) > 0)
		if (at === -1) continue
		throw new CombError({
			cause: `shard ${shard}'s rows came back out of the order paginateMerged merges by, at row ${at}: a merged list's sort keys must use SQLite's default BINARY collation`,
			errorKey: combErrorKeys.SORT_NOT_WIRED,
			status: "internal_server_error",
		})
	}
}

/** A merged list's ids must be unique across shards, or a cursor's anchor names more than one row (Q10) */
function refuseSharedIds(rows: ReadonlyArray<Record<string, unknown>>, idField: string): void {
	const seen = new Set<unknown>()
	for (const row of rows) {
		const id = row[idField]
		if (!seen.has(id)) {
			seen.add(id)
			continue
		}
		throw new CombError({
			cause: `two shards hold id ${JSON.stringify(id)}: a merged list's ids must be unique across its shards`,
			errorKey: combErrorKeys.SORT_NOT_WIRED,
			status: "internal_server_error",
		})
	}
}

/**
 * The merged rows a cursor page may serve, ordered: none at or before the cursor's row, which a
 * shard that resumed early read again, and none past the earliest last row of a shard that read
 * its whole limit + 1, which may hold more before its next read (Q1). A shard that read limit + 1
 * rows and none past the cursor could not move the list on: refused
 */
function pastCursor<T extends Record<string, unknown>>(
	rows: T[],
	rowsPerShard: ReadonlyArray<ReadonlyArray<T>>,
	{
		anchor,
		compare,
		limit,
	}: { anchor: Record<string, unknown> | undefined; compare: ReturnType<typeof compareRows>; limit: number },
): { full: boolean; rows: T[] } {
	const past = anchor === undefined ? rows : rows.filter((row) => compare(row, anchor) > 0)
	const lasts = rowsPerShard.filter((shard) => shard.length > limit).map((shard) => shard.at(-1) as T)
	const end = lasts.toSorted(compare)[0]
	const kept = end === undefined ? past : past.filter((row) => compare(row, end) <= 0)
	if (end !== undefined && kept.length === 0) {
		throw new CombError({
			cause:
				"a shard read its whole limit and every row it read was at or before the cursor: its read resumed before the cursor's row",
			errorKey: combErrorKeys.SORT_NOT_WIRED,
			status: "internal_server_error",
		})
	}
	return { full: end !== undefined, rows: kept }
}

/** The cursor's row as the merge compares rows: each key's value and the id; none when a value is a reference, which no row's value equals */
function anchorOf(cursor: string, sort: SortField[], options: PaginateOptions): Record<string, unknown> | undefined {
	const { id, values } = readCursor(cursor, sort, options)
	if (values.some((value) => value instanceof CursorRef)) return undefined
	const idField = options.idField ?? CURSOR_TIEBREAK_COLUMN
	return Object.fromEntries([...sort.map(({ field }, i) => [field, values[i]]), [idField, id]])
}

/**
 * Rows every shard's filter matches, summed: each shard's offset read carries its own total on
 * its rows (`countExtra`), and one that read none matches none. Null for a cursor page, or once a
 * shard's rows carry no total.
 */
function countOf(rowsPerShard: ReadonlyArray<ReadonlyArray<{ _total?: number }>>, cursor: string | undefined) {
	if (cursor) return null
	let total = 0
	for (const rows of rowsPerShard) {
		const first = rows[0]
		if (first === undefined) continue
		if (first._total === undefined) return null
		total += first._total
	}
	return total
}

/**
 * The page of a list merged from `rowsPerShard`, each shard's rows read with `mergedListOptions`,
 * and its pagination, as `paginate` gives one database's: ordered as the list orders, windowed by
 * page or cursor, counted across shards, its next cursor sealed under `options`. Ids must be
 * unique across the shards, as a cursor names its row by id
 */
function paginateMerged<T extends object>(
	rowsPerShard: ReadonlyArray<ReadonlyArray<T & { _total?: number }>>,
	query: {
		cursor?: string | undefined
		limit: number
		page?: number | undefined
		parsedFields?: ParsedFields | null | undefined
		parsedSort: SortField[]
	},
	options: PaginateOptions,
): readonly [T[], z.output<typeof paginationResponseSchema>] {
	const shards = rowsPerShard as ReadonlyArray<ReadonlyArray<T & Record<string, unknown>>>
	const merged = shards.flat()
	refuseGoneAnchor(merged)
	const idField = options.idField ?? CURSOR_TIEBREAK_COLUMN
	refuseSharedIds(merged, idField)
	const compare = compareRows(query.parsedSort, idField)
	refuseUnmergeable(shards, compare)
	merged.sort(compare)
	const anchor = query.cursor ? anchorOf(query.cursor, query.parsedSort, options) : undefined
	const { full, rows } = query.cursor
		? pastCursor(merged, shards, { anchor, compare, limit: query.limit })
		: { full: false, rows: merged }
	const start = query.cursor ? 0 : ((query.page ?? 1) - 1) * query.limit
	const window = rows.slice(start, start + query.limit + 1)
	const hasMore = full || window.length > query.limit
	const page = hasMore ? window.slice(0, query.limit) : window
	const last = page.at(-1)
	const pagination = {
		count: countOf(rowsPerShard, query.cursor),
		hasMore,
		limit: query.limit,
		nextCursor: hasMore && last !== undefined ? mintFrom(last, query.parsedSort, options) : null,
		page: query.cursor ? null : (query.page ?? 1),
	}
	return [page.map((row) => applySelect(row, query.parsedFields ?? null)), pagination] as const
}

export { type MergedListOptions, mergedListOptions, paginateMerged }
