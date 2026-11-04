/**
 * Cursor-based pagination — encode/decode + pagination helpers.
 * DB-agnostic: no SQL dependencies.
 *
 * A cursor is its payload, JSON, sealed under the app's cursor secret and the list's scope
 * (cursor-seal.ts): a client can neither read the sort values it carries nor write one, nor spend
 * it in another list. Only an opening call, readCursor, hands back its values; the list schema
 * checks its shape alone, as it holds no secret.
 */
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import {
	carried,
	CursorRef,
	decodeId,
	decodeValue,
	encodeValue,
	type CursorId,
	type CursorValue,
} from "./cursor-codec.ts"
import { assertCursorWired, type CursorOptions, isSealedShape, openSealed, seal } from "./cursor-seal.ts"
import type { SortDirection, SortField, SortNulls } from "./types.ts"

/**
 * Column keyset pagination breaks ties on.
 *
 * This is the single source of truth for the tiebreak: the SQL builders resolve
 * the column by this name, and `createListQuerySchema` publishes it as
 * `stableTiebreak`. Keeping one constant is what stops the published fact from
 * drifting away from the query that is actually run.
 *
 * A table whose primary-key property is named something else has no cursor
 * predicate applied at all — rows then duplicate and skip across pages — so
 * `validateTables()` rejects that shape rather than letting it fail silently.
 */
const CURSOR_TIEBREAK_COLUMN = "id"

/**
 * The longest cursor a list takes, and so the longest comb mints: it fits a URL. A cursor carries
 * its sort values, so a long text key could mint one past it, which the next page would refuse.
 */
const MAX_CURSOR_LENGTH = 8192

/**
 * Wire payload. `s` is the sort signature the cursor was minted under, `v` one
 * value per sort key in order, `i` the tiebreak id. A cursor is only valid for
 * the exact sort that produced it.
 */
type CursorPayload = {
	i: CursorId
	s: string
	v: unknown[]
}

type DecodedCursor = {
	id: CursorId
	sort: string
	values: CursorValue[]
}

type PaginationMeta = {
	/** Rows the filter matches across all pages; null when the response cannot know */
	count: number | null
	hasMore: boolean
	limit: number
	nextCursor: string | null
	page: number | null
}

/** PostgreSQL semantics: nulls sort last ascending and first descending. */
function effectiveNulls(direction: SortDirection, nulls?: SortNulls): SortNulls {
	return nulls ?? (direction === "asc" ? "last" : "first")
}

/** Canonical form of a sort — what a cursor is bound to. */
function sortSignature(parsedSort: readonly SortField[]): string {
	return parsedSort
		.map(({ direction, field, nulls }) => `${field}.${direction}.nulls${effectiveNulls(direction, nulls)}`)
		.join(",")
}

/** A sealed cursor for `payload`, opened only under the same `options` */
function encodeCursor(payload: CursorPayload, options: CursorOptions): string {
	const json = JSON.stringify({ ...payload, i: encodeValue(payload.i), v: payload.v.map(encodeValue) })
	return seal(new TextEncoder().encode(json), options)
}

/** The opened payload's cursor, or null when it is not one this version minted */
function decodePayload(bytes: Uint8Array): DecodedCursor | null {
	try {
		const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown
		if (typeof parsed !== "object" || parsed === null) return null
		const { i, s, v } = parsed as Partial<Record<keyof CursorPayload, unknown>>
		const id = decodeId(i)
		if (id === undefined || typeof s !== "string" || !Array.isArray(v)) return null
		const values = v.map(decodeValue)
		/* a value the database cannot compare would reach the driver and fail there with a 500 */
		if (values.includes(undefined)) return null
		return { id, sort: s, values: values as CursorValue[] }
	} catch {
		// reason: bytes that are not UTF-8 JSON are not a cursor; callers answer with invalid_cursor
		return null
	}
}

/** Whether `value` is an integer a JS number rounds: past ±(2^53 − 1), a lossy read of the row's key (U22) */
const lossy = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)

/**
 * Throw a 500 for a tiebreak id a JS number rounds, which cannot find its own row, so the keyset
 * would repeat or skip it (U22), and two unique ids may read as one (Q6 of r20)
 */
function refuseRoundedId(record: Record<string, unknown>, idField: string): void {
	if (!lossy(record[idField])) return
	throw new CombError({
		cause: `the tiebreak id ${idField} reads ${String(record[idField])}, past 2^53, where a JS number rounds it, so no cursor can find its row; read it exactly (bun:sqlite safeIntegers, libsql intMode: "bigint", drizzle's mode: "bigint" on Postgres), or on D1 key the table by a text id`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})
}

/** What a value no cursor carries is, for the 500 that names it */
function kindOf(value: unknown): string {
	if (Array.isArray(value)) return "an array"
	return typeof value === "bigint" ? "an integer past 20 digits" : `a ${typeof value}`
}

/**
 * Throw a 500 naming the field for a row a cursor cannot resume after (QL5 of r22b): one without a
 * sort field or its id (a key set to undefined is one left out), or one whose value the cursor
 * would not read back as itself, a JSON object, an array or a function, which would mint a cursor
 * the next page refused as invalid
 */
function refuseUncarried(record: Record<string, unknown>, parsedSort: readonly SortField[], idField: string): void {
	const fields = [...parsedSort.map(({ field }) => field), idField]
	const missing = fields.filter((field) => record[field] === undefined)
	if (missing.length > 0) {
		throw new CombError({
			cause: `the next cursor is minted from each row's ${missing.join(", ")}; select them, and the built query's extras`,
			errorKey: combErrorKeys.SORT_NOT_WIRED,
			status: "internal_server_error",
		})
	}
	const key = parsedSort.find(({ field }) => !carried(record[field], decodeValue))
	if (key !== undefined) {
		throw new CombError({
			cause: `the sort by ${key.field} reads ${kindOf(record[key.field])}, which no cursor carries: sort by a column of text, numbers, booleans, times or bytes`,
			errorKey: combErrorKeys.SORT_NOT_WIRED,
			status: "internal_server_error",
		})
	}
	if (carried(record[idField], decodeId)) return
	throw new CombError({
		cause: `the tiebreak id ${idField} reads ${kindOf(record[idField])}, which no cursor carries: key the table by text or an integer`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})
}

/**
 * Mint the cursor for the row after which the next page starts, sealed under `options` and keyed
 * by `idField`, whole: the public `createCursor` (cursor-mint.ts) keeps it within the cap (U37). A
 * row it cannot resume after is a 500 here, on the page that reads it (refuseUncarried)
 */
function mintCursor(
	record: Record<string, unknown>,
	parsedSort: readonly SortField[],
	options: CursorOptions & { idField?: string | undefined },
): string {
	const idField = options?.idField ?? CURSOR_TIEBREAK_COLUMN
	refuseRoundedId(record, idField)
	refuseUncarried(record, parsedSort, idField)
	return encodeCursor(
		{ i: record[idField] as CursorId, s: sortSignature(parsedSort), v: parsedSort.map(({ field }) => record[field]) },
		options,
	)
}

/**
 * Why `cursor` cannot be one, or null when its shape can: the list schema's check, a 400 at
 * validation. What it holds, and the sort it was minted under, only readCursor can open.
 */
function cursorProblem(cursor: string): string | null {
	return isSealedShape(cursor) ? null : "Invalid cursor"
}

function signatureProblem(decoded: DecodedCursor, parsedSort: readonly SortField[]): string | null {
	const matches = decoded.sort === sortSignature(parsedSort) && decoded.values.length === parsedSort.length
	return matches ? null : "Cursor was issued for a different order"
}

/** The cursor sealed under `options`, opened and decoded; null when it was not, or it is no cursor */
function openCursor(cursor: string, options: CursorOptions): DecodedCursor | null {
	const bytes = openSealed(cursor, options)
	return bytes === null ? null : decodePayload(bytes)
}

/**
 * Open a cursor under `options` and decode it for this sort, or throw a 400 CombError. A value may
 * be a CursorRef: a long sort value carried by reference, its prefix and length, which a keyset
 * of its own must read from the cursor's row (cursor-ref.ts), never bind as it is.
 */
function readCursor(cursor: string, parsedSort: readonly SortField[], options: CursorOptions): DecodedCursor {
	/* options that cannot seal are the handler's 500 whatever the cursor, a long one too (U12) */
	assertCursorWired(options)
	/* longer than any cursor comb mints: refused before it is decoded */
	const decoded = cursor.length > MAX_CURSOR_LENGTH ? null : openCursor(cursor, options)
	const problem = decoded ? signatureProblem(decoded, parsedSort) : "Invalid cursor"
	if (problem) throw new CombError({ cause: problem, errorKey: combErrorKeys.INVALID_CURSOR, status: "bad_request" })
	return decoded as DecodedCursor
}

export {
	CursorRef,
	CURSOR_TIEBREAK_COLUMN,
	MAX_CURSOR_LENGTH,
	cursorProblem,
	effectiveNulls,
	encodeCursor,
	lossy,
	mintCursor,
	readCursor,
	refuseRoundedId,
	sortSignature,
	type CursorId,
	type CursorOptions,
	type CursorPayload,
	type CursorValue,
	type DecodedCursor,
	openCursor,
	type PaginationMeta,
}
