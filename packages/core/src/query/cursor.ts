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

/** The tiebreak id as the row held it: a number stays a number, so it compares as one */
type CursorId = number | string

type DecodedCursor = {
	id: CursorId
	sort: string
	values: CursorValue[]
}

/** What a sort key can hold and SQLite can compare */
type CursorValue = boolean | Date | number | string | null

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

/* Dates survive JSON as tagged epoch ms so a timestamp column compares as one. */
const DATE_TAG = "$date"

function encodeValue(value: unknown): unknown {
	return value instanceof Date ? { [DATE_TAG]: value.getTime() } : (value ?? null)
}

const isId = (value: unknown): value is CursorId =>
	typeof value === "string" || (typeof value === "number" && Number.isFinite(value))

/** A sort value from the wire, or undefined when it is not one a cursor can carry */
function decodeValue(value: unknown): CursorValue | undefined {
	if (value === null || typeof value === "boolean" || isId(value)) return value
	if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return undefined
	const time = (value as Record<string, unknown>)[DATE_TAG]
	return typeof time === "number" && Number.isFinite(time) ? new Date(time) : undefined
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
		const { i, s, v } = parsed as Partial<Record<keyof CursorPayload, unknown>>
		if (!isId(i) || typeof s !== "string" || !Array.isArray(v)) return null
		const values = v.map(decodeValue)
		/* a value SQLite cannot compare would reach the driver and fail there with a 500 */
		if (values.includes(undefined)) return null
		return { id: i, sort: s, values: values as CursorValue[] }
	} catch {
		// reason: text that is not base64url JSON is not a cursor; callers answer with invalid_cursor
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
		i: record[idField] as CursorId,
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
	return decoded ? signatureProblem(decoded, parsedSort) : "Invalid cursor"
}

function signatureProblem(decoded: DecodedCursor, parsedSort: readonly SortField[]): string | null {
	const matches = decoded.sort === sortSignature(parsedSort) && decoded.values.length === parsedSort.length
	return matches ? null : "Cursor was issued for a different order"
}

/** Decode a cursor for this sort, or throw a 400 CombError. */
function readCursor(cursor: string, parsedSort: readonly SortField[]): DecodedCursor {
	const decoded = decodeCursor(cursor)
	const problem = decoded ? signatureProblem(decoded, parsedSort) : "Invalid cursor"
	if (problem) throw new CombError({ cause: problem, errorKey: combErrorKeys.INVALID_CURSOR, status: "bad_request" })
	return decoded as DecodedCursor
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
	effectiveNulls,
	encodeCursor,
	getPrimarySortDirection,
	readCursor,
	sortSignature,
	type CursorId,
	type CursorPayload,
	type CursorValue,
	type DecodedCursor,
	type PaginationMeta,
	type PaginationOptions,
	type PaginationQueryInput,
}
