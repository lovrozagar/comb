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
import { type CursorOptions, isSealedShape, openSealed, seal } from "./cursor-seal.ts"
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

/** A sort value carried by reference (cursor-ref.ts): the prefix of it that fit, the rest read from the row */
class CursorRef {
	readonly prefix: string

	constructor(prefix: string) {
		this.prefix = prefix
	}
}

/** What a sort key can hold and its database can compare, or a long one carried by reference */
type CursorValue = bigint | boolean | CursorRef | Date | number | string | null

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

/* Dates survive JSON as tagged epoch ms so a timestamp column compares as one, a bigint as its
   decimal digits, and a number JSON has none for (±Infinity, NaN) as its name, not as null */
const DATE_TAG = "$date"
const BIGINT_TAG = "$bigint"
const NUM_TAG = "$num"
const REF_TAG = "$ref"
const NON_FINITE = ["Infinity", "-Infinity", "NaN"]

function encodeValue(value: unknown): unknown {
	if (value instanceof Date) return { [DATE_TAG]: value.getTime() }
	if (value instanceof CursorRef) return { [REF_TAG]: value.prefix }
	if (typeof value === "number" && !Number.isFinite(value)) return { [NUM_TAG]: String(value) }
	return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : (value ?? null)
}

const isPlain = (value: unknown): value is number | string =>
	typeof value === "string" || (typeof value === "number" && Number.isFinite(value))

/** A tagged value from the wire: a Date a JS Date can hold, a bigint of decimal digits, ±Infinity or NaN, or a reference */
function decodeTagged(value: Record<string, unknown>): CursorRef | Date | bigint | number | undefined {
	const prefix = value[REF_TAG]
	if (typeof prefix === "string") return new CursorRef(prefix)
	const named = value[NUM_TAG]
	if (typeof named === "string") return NON_FINITE.includes(named) ? Number(named) : undefined
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

/** A sealed cursor for `payload`, opened only under the same `options` */
function encodeCursor(payload: CursorPayload, options: CursorOptions): string {
	const json = JSON.stringify({ ...payload, i: encodeValue(payload.i), v: payload.v.map(encodeValue) })
	return seal(new TextEncoder().encode(json), options)
}

/** The opened payload's cursor, or null when it is not one this version minted */
function decodePayload(bytes: Uint8Array): DecodedCursor | null {
	try {
		const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
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

/** Mint the cursor for the row after which the next page starts, sealed under `options` and keyed by `idField` */
function createCursor(
	record: Record<string, unknown>,
	parsedSort: readonly SortField[],
	options: CursorOptions & { idField?: string | undefined },
): string {
	const idField = options?.idField ?? CURSOR_TIEBREAK_COLUMN
	/* a Date no JS Date holds (Postgres 'infinity' read in date mode) has lost its sign: a cursor
	   would mean NULL and skip or repeat rows, so the sort is refused on the page that meets it */
	const unheld = parsedSort.find(
		({ field }) => record[field] instanceof Date && Number.isNaN((record[field] as Date).getTime()),
	)
	if (unheld !== undefined) {
		throw new CombError({
			cause: `the sort by ${unheld.field} reads a date no JS Date holds, as Postgres 'infinity' reads in date mode; select it in string mode or sort by another column`,
			errorKey: combErrorKeys.SORT_NOT_WIRED,
			status: "internal_server_error",
		})
	}
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

/** Open a cursor under `options` and decode it for this sort, or throw a 400 CombError. */
function readCursor(cursor: string, parsedSort: readonly SortField[], options: CursorOptions): DecodedCursor {
	const decoded = openCursor(cursor, options)
	const problem = decoded ? signatureProblem(decoded, parsedSort) : "Invalid cursor"
	if (problem) throw new CombError({ cause: problem, errorKey: combErrorKeys.INVALID_CURSOR, status: "bad_request" })
	return decoded as DecodedCursor
}

export {
	createCursor,
	CursorRef,
	CURSOR_TIEBREAK_COLUMN,
	MAX_CURSOR_LENGTH,
	cursorProblem,
	effectiveNulls,
	encodeCursor,
	readCursor,
	sortSignature,
	type CursorId,
	type CursorOptions,
	type CursorPayload,
	type CursorValue,
	type DecodedCursor,
	openCursor,
	type PaginationMeta,
}
