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

/** The tiebreak id as the row held it: a number stays a number, a bigint a bigint, so it compares as one */
type CursorId = bigint | number | string

type DecodedCursor = {
	id: CursorId
	sort: string
	values: CursorValue[]
}

/**
 * A sort value carried by reference (cursor-ref.ts): the prefix of it that fit and the whole
 * value's length, both in code points as SQLite's substr() and Postgres's left() count them; the
 * rest is read from the row while it still has that prefix and length
 */
class CursorRef {
	readonly length: number
	readonly prefix: string

	constructor(prefix: string, length: number) {
		this.prefix = prefix
		this.length = length
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
	/* a Date no JS Date holds, a date-mode ±infinity, stays a Date: null under the tag, never the null group (3.24) */
	if (value instanceof Date) return { [DATE_TAG]: Number.isNaN(value.getTime()) ? null : value.getTime() }
	if (value instanceof CursorRef) return { [REF_TAG]: [value.prefix, value.length] }
	if (typeof value === "number" && !Number.isFinite(value)) return { [NUM_TAG]: String(value) }
	return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : (value ?? null)
}

const isPlain = (value: unknown): value is number | string =>
	typeof value === "string" || (typeof value === "number" && Number.isFinite(value))

/** A reference from the wire: its prefix, and a whole length the prefix fits in; a 0.12 reference, a bare prefix, is none */
function decodeRef(ref: unknown): CursorRef | undefined {
	if (!Array.isArray(ref) || ref.length !== 2) return undefined
	const [prefix, length] = ref as [unknown, unknown]
	if (typeof prefix !== "string" || !Number.isSafeInteger(length)) return undefined
	return (length as number) >= Array.from(prefix).length ? new CursorRef(prefix, length as number) : undefined
}

/** A tagged value from the wire: a Date a JS Date can hold, a bigint of decimal digits, ±Infinity or NaN, or a reference */
function decodeTagged(value: Record<string, unknown>): CursorRef | Date | bigint | number | undefined {
	if (Object.hasOwn(value, REF_TAG)) return decodeRef(value[REF_TAG])
	const named = value[NUM_TAG]
	if (typeof named === "string") return NON_FINITE.includes(named) ? Number(named) : undefined
	const time = value[DATE_TAG]
	/* an infinity read in date mode: its bound is read from its row (cursor-ref.ts), never bound itself */
	if (time === null) return new Date(Number.NaN)
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
 * Mint the cursor for the row after which the next page starts, sealed under `options` and keyed
 * by `idField`, whole: the public `createCursor` (cursor-mint.ts) keeps it within the cap (U37)
 */
function mintCursor(
	record: Record<string, unknown>,
	parsedSort: readonly SortField[],
	options: CursorOptions & { idField?: string | undefined },
): string {
	const idField = options?.idField ?? CURSOR_TIEBREAK_COLUMN
	/* a tiebreak id a JS number rounds cannot find its own row, so the keyset would repeat or skip it (U22) */
	if (lossy(record[idField])) {
		throw new CombError({
			cause: `the tiebreak id ${idField} reads ${String(record[idField])}, past 2^53, where a JS number rounds it, so no cursor can find its row; read it exactly (bun:sqlite safeIntegers, libsql intMode: "bigint", drizzle's mode: "bigint" on Postgres), or on D1 key the table by a text id`,
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
	sortSignature,
	type CursorId,
	type CursorOptions,
	type CursorPayload,
	type CursorValue,
	type DecodedCursor,
	openCursor,
	type PaginationMeta,
}
