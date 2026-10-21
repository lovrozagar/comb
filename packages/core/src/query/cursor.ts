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

/** The tiebreak id as the row held it: a number stays a number, a bigint a bigint, so it compares as one */
type CursorId = bigint | number | string

type DecodedCursor = {
	id: CursorId
	sort: string
	values: CursorValue[]
}

/** What a sort key can hold and its database can compare */
type CursorValue = bigint | boolean | Date | number | string | null

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

/* Dates survive JSON as tagged epoch ms so a timestamp column compares as one, and a bigint as its decimal digits */
const DATE_TAG = "$date"
const BIGINT_TAG = "$bigint"

function encodeValue(value: unknown): unknown {
	if (value instanceof Date) return { [DATE_TAG]: value.getTime() }
	return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : (value ?? null)
}

const isPlain = (value: unknown): value is number | string =>
	typeof value === "string" || (typeof value === "number" && Number.isFinite(value))

/** A tagged value from the wire: a Date a JS Date can hold, or a bigint of decimal digits */
function decodeTagged(value: Record<string, unknown>): Date | bigint | undefined {
	const time = value[DATE_TAG]
	/* a forged time a Date cannot hold reads as Invalid Date, which no driver binds */
	if (typeof time === "number") return Number.isNaN(new Date(time).getTime()) ? undefined : new Date(time)
	const digits = value[BIGINT_TAG]
	return typeof digits === "string" && /^-?\d{1,20}$/.test(digits) ? BigInt(digits) : undefined
}

/** A sort value from the wire, or undefined when it is not one a cursor can carry */
function decodeValue(value: unknown): CursorValue | undefined {
	if (value === null || typeof value === "boolean" || isPlain(value)) return value
	if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return undefined
	return decodeTagged(value as Record<string, unknown>)
}

/** The tiebreak id from the wire: a string, a finite number, or a tagged bigint */
function decodeId(value: unknown): CursorId | undefined {
	const id = decodeValue(value)
	return typeof id === "bigint" || isPlain(id) ? id : undefined
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
	return toBase64Url(JSON.stringify({ ...payload, i: encodeValue(payload.i), v: payload.v.map(encodeValue) }))
}

/** null when the string is not a cursor this version minted. */
function decodeCursor(cursor: string | null | undefined): DecodedCursor | null {
	if (!cursor) return null
	try {
		const parsed = JSON.parse(fromBase64Url(cursor)) as unknown
		if (typeof parsed !== "object" || parsed === null) return null
		const { i, s, v } = parsed as Partial<Record<keyof CursorPayload, unknown>>
		const id = decodeId(i)
		if (id === undefined || typeof s !== "string" || !Array.isArray(v)) return null
		const values = v.map(decodeValue)
		/* a value the database cannot compare would reach the driver and fail there with a 500 */
		if (values.includes(undefined)) return null
		return { id, sort: s, values: values as CursorValue[] }
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

export {
	createCursor,
	CURSOR_TIEBREAK_COLUMN,
	MAX_CURSOR_LENGTH,
	cursorProblem,
	decodeCursor,
	effectiveNulls,
	encodeCursor,
	readCursor,
	sortSignature,
	type CursorId,
	type CursorPayload,
	type CursorValue,
	type DecodedCursor,
	type PaginationMeta,
}
