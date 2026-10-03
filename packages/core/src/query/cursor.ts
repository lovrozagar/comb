/**
 * Cursor-based pagination — encode/decode + pagination helpers.
 * DB-agnostic: no SQL dependencies.
 */
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
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

/** Sort applied when a request names none and the caller supplied no default. */
const DEFAULT_SORT: readonly SortField[] = [{ direction: "desc", field: "created_at" }]

/**
 * Wire payload. `s` is the sort signature the cursor was minted under, `v` one
 * value per sort key in order, `i` the tiebreak id. A cursor is only valid for
 * the exact sort that produced it.
 */
type CursorPayload = {
	i: string
	s: string
	v: unknown[]
}

type DecodedCursor = {
	id: string
	sort: string
	values: unknown[]
}

type PaginationQueryInput = {
	cursor?: string
	limit: number
	page?: number
	parsedSort: SortField[]
}

type PaginationOptions = {
	limit: number
	offset: number
}

type PaginationMeta = {
	count: number
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

/* Dates survive JSON as tagged epoch ms so a timestamp column compares as one. */
const DATE_TAG = "$date"

function encodeValue(value: unknown): unknown {
	return value instanceof Date ? { [DATE_TAG]: value.getTime() } : (value ?? null)
}

function decodeValue(value: unknown): unknown {
	if (typeof value === "object" && value !== null && DATE_TAG in value) {
		return new Date((value as Record<string, number>)[DATE_TAG] as number)
	}
	return value
}

function toBase64Url(text: string): string {
	let binary = ""
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(encoded: string): string {
	const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
	const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="))
	return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

function encodeCursor(payload: CursorPayload): string {
	return toBase64Url(JSON.stringify({ ...payload, v: payload.v.map(encodeValue) }))
}

/** null when the string is not a cursor this version minted. */
function decodeCursor(cursor: string | null | undefined): DecodedCursor | null {
	if (!cursor) return null
	try {
		const parsed = JSON.parse(fromBase64Url(cursor)) as unknown
		if (typeof parsed !== "object" || parsed === null) return null
		const { i, s, v } = parsed as Partial<CursorPayload>
		if (typeof i !== "string" || typeof s !== "string" || !Array.isArray(v)) return null
		return { id: i, sort: s, values: v.map(decodeValue) }
	} catch {
		return null
	}
}

/** Mint the cursor for the row after which the next page starts. */
function createCursor(
	record: Record<string, unknown>,
	parsedSort: readonly SortField[],
	opts?: { idField?: string },
): string {
	const idField = opts?.idField ?? CURSOR_TIEBREAK_COLUMN
	return encodeCursor({
		i: String(record[idField]),
		s: sortSignature(parsedSort),
		v: parsedSort.map(({ field }) => record[field]),
	})
}

/**
 * Why a cursor cannot be used under this sort, or null when it can.
 * Shared by the schema (400 at validation) and the SQL builders (CombError).
 */
function cursorProblem(cursor: string, parsedSort: readonly SortField[]): string | null {
	const decoded = decodeCursor(cursor)
	if (!decoded) return "Invalid cursor"
	if (decoded.sort !== sortSignature(parsedSort) || decoded.values.length !== parsedSort.length) {
		return "Cursor was issued for a different order"
	}
	return null
}

/** Decode a cursor for this sort, or throw a 400 CombError. */
function readCursor(cursor: string, parsedSort: readonly SortField[]): DecodedCursor {
	const problem = cursorProblem(cursor, parsedSort)
	const decoded = decodeCursor(cursor)
	if (problem || !decoded) {
		throw new CombError({
			cause: problem ?? "Invalid cursor",
			errorKey: combErrorKeys.INVALID_CURSOR,
			status: "bad_request",
		})
	}
	return decoded
}

/** Get primary sort direction from parsed sort array, defaults to "desc" */
function getPrimarySortDirection(parsedSort: readonly SortField[]): SortDirection {
	return parsedSort[0]?.direction ?? "desc"
}

export {
	createCursor,
	CURSOR_TIEBREAK_COLUMN,
	cursorProblem,
	decodeCursor,
	DEFAULT_SORT,
	effectiveNulls,
	encodeCursor,
	getPrimarySortDirection,
	readCursor,
	sortSignature,
	type CursorPayload,
	type DecodedCursor,
	type PaginationMeta,
	type PaginationOptions,
	type PaginationQueryInput,
}
