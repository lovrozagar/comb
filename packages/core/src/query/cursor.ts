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
	CursorRef,
	decodeId,
	decodeValue,
	encodeValue,
	RealText,
	realTextOf,
	type CursorId,
	type CursorValue,
} from "./cursor-codec.ts"
import { readOf, readSlot } from "./cursor-reads.ts"
import { refuseComputedSort, refuseRoundedId, refuseUncarried } from "./cursor-refusals.ts"
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
	/* per key, whether its value is the stored text the list carried rather than the value as read; left out when none is (comb-9d's AB2 ruling) */
	c?: boolean[] | undefined
	/* per key, the value its row read where the keyset binds another, encoded alone in an array, else null; left out when no key has one (AB3-3 of area B); a cursor minted before holds a Date's epoch milliseconds or "invalid" */
	d?: Array<[unknown] | number | "invalid" | null> | undefined
	i: CursorId
	/* per key, whether its value is a SQLite REAL's text, which the next page binds as cast(? as real); left out when none is (AB4-7 of area B) */
	r?: boolean[] | undefined
	s: string
	v: unknown[]
}

/** An opened cursor, as `readCursor` returns it */
type DecodedCursor = {
	/** per sort value, true where it is its key's stored text, which the next page binds as itself; false where it is the value as the row read it */
	carried: boolean[]
	/** the tiebreak id of the row the next page starts after */
	id: CursorId
	/** the signature of the sort it was minted under, as `sortSignature` writes it */
	sort: string
	/** one value per sort key, in order */
	values: CursorValue[]
}

/*
 * a cursor as the keyset binds it, a REAL's text as its RealText (AB4-7 of area B), and per key the
 * value its row read where the keyset binds another, null else; none when no key has one
 */
type OpenedCursor = Omit<DecodedCursor, "values"> & {
	read?: Array<readonly [CursorValue] | null> | undefined
	values: Array<CursorValue | RealText>
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

/** A sealed cursor for `payload`, opened only under the same `cursorSecret` and `cursorScope` */
function encodeCursor(payload: CursorPayload, options: CursorOptions): string {
	return seal(payloadBytes(payload), options)
}

/** What seal encrypts for `payload`: its JSON, each value encoded, as UTF-8 */
function payloadBytes(payload: CursorPayload): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({ ...payload, i: encodeValue(payload.i), v: payload.v.map(encodeValue) }),
	)
}

/** Each key's carried flag from the wire; none is every key as read, as every cursor a released comb minted holds */
function carriedOf(c: unknown, count: number): boolean[] | undefined {
	if (c === undefined) return Array.from({ length: count }, () => false)
	return Array.isArray(c) && c.length === count && c.every((flag) => typeof flag === "boolean") ? c : undefined
}

/** The opened payload's cursor, or null when it is not one this version minted */
function decodePayload(bytes: Uint8Array): OpenedCursor | null {
	try {
		const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown
		if (typeof parsed !== "object" || parsed === null) return null
		const { c, d, i, r, s, v } = parsed as Partial<Record<keyof CursorPayload, unknown>>
		const id = decodeId(i)
		if (id === undefined || typeof s !== "string" || !Array.isArray(v)) return null
		const reals = carriedOf(r, v.length)
		const values = v.map((value, at) => (reals?.[at] === true ? realTextOf(value) : decodeValue(value)))
		const flags = carriedOf(c, v.length)
		const read = readOf(d, v.length, decodeValue)
		/* a value the database cannot compare would reach the driver and fail there with a 500 */
		if (values.includes(undefined) || flags === undefined || reals === undefined || read === null) return null
		return { carried: flags, id, ...(read && { read }), sort: s, values: values as Array<CursorValue | RealText> }
	} catch {
		// reason: bytes that are not UTF-8 JSON are not a cursor; callers answer with invalid_cursor
		return null
	}
}

/**
 * Mint the cursor for the row after which the next page starts, sealed under `options` and keyed
 * by `idField`, whole: the public `createCursor` (cursor-mint.ts) keeps it within the cap (U37). A
 * row it cannot resume after is a 500 here, on the page that reads it (refuseUncarried). `read` is
 * the row as the driver read it, whose value readCursor returns for a key `record` binds otherwise
 */
function mintCursor(
	record: Record<string, unknown>,
	parsedSort: readonly SortField[],
	options: CursorOptions & MintOptions,
): string {
	return seal(cursorBytes(record, parsedSort, options), options)
}

/** What a mint is told beside the seal's options: the carried keys, the id's field, and the row as read */
type MintOptions = {
	carried?: ReadonlySet<string> | undefined
	idField?: string | undefined
	read?: Record<string, unknown> | undefined
}

/**
 * What mintCursor seals for `record`, every refusal of it run: the cursor's length, which the bytes'
 * count alone sets (sealedLength), is known before any seal, so a page checks each row it serves
 */
function cursorBytes(
	record: Record<string, unknown>,
	parsedSort: readonly SortField[],
	options: MintOptions | undefined,
): Uint8Array {
	const idField = options?.idField ?? CURSOR_TIEBREAK_COLUMN
	const flags = parsedSort.map(({ field }) => options?.carried?.has(field) ?? false)
	const read = parsedSort.map(({ field }) => readSlot(options?.read?.[field], record[field]))
	refuseComputedSort(parsedSort)
	refuseRoundedId(record, idField)
	refuseUncarried(record, parsedSort, idField)
	const reals = parsedSort.map(({ field }) => record[field] instanceof RealText)
	return payloadBytes({
		...(flags.includes(true) && { c: flags }),
		...(read.some((slot) => slot !== null) && { d: read }),
		i: record[idField] as CursorId,
		...(reals.includes(true) && { r: reals }),
		s: sortSignature(parsedSort),
		v: parsedSort.map(({ field }) => record[field]),
	})
}

/**
 * Why `cursor` cannot be one, or null when its shape can: the list schema's check, a 400 at
 * validation. What it holds, and the sort it was minted under, only readCursor can open.
 */
function cursorProblem(cursor: string): string | null {
	return isSealedShape(cursor) ? null : "Invalid cursor"
}

function signatureProblem(
	decoded: Pick<OpenedCursor, "sort" | "values">,
	parsedSort: readonly SortField[],
): string | null {
	const matches = decoded.sort === sortSignature(parsedSort) && decoded.values.length === parsedSort.length
	return matches ? null : "Cursor was issued for a different order"
}

/** The cursor sealed under `options`, opened and decoded; null when it was not, or it is no cursor */
function openCursor(cursor: string, options: CursorOptions): OpenedCursor | null {
	const bytes = openSealed(cursor, options)
	return bytes === null ? null : decodePayload(bytes)
}

/** The cursor as the keyset binds it, each key's stored value, for this sort; a 400 CombError as readCursor throws */
function readKeyset(cursor: string, parsedSort: readonly SortField[], options: CursorOptions): OpenedCursor {
	/* options that cannot seal are the handler's 500 whatever the cursor, a long one too (U12) */
	assertCursorWired(options)
	/* longer than any cursor comb mints: refused before it is decoded */
	const decoded = cursor.length > MAX_CURSOR_LENGTH ? null : openCursor(cursor, options)
	const problem = decoded ? signatureProblem(decoded, parsedSort) : "Invalid cursor"
	if (problem) throw new CombError({ cause: problem, errorKey: combErrorKeys.INVALID_CURSOR, status: "bad_request" })
	return decoded as OpenedCursor
}

/**
 * The cursor as the merge compares rows with it: readKeyset's, a REAL's text as the number typedKeys
 * parses each shard's row's text to, the same parse of the same text (AB4-7 of area B)
 */
function readCompared(cursor: string, parsedSort: readonly SortField[], options: CursorOptions): DecodedCursor {
	const { read: _read, ...decoded } = readKeyset(cursor, parsedSort, options)
	return { ...decoded, values: decoded.values.map((value) => (value instanceof RealText ? Number(value.text) : value)) }
}

/**
 * Open a cursor under `options` and decode it for this sort, or throw a 400 CombError. Each key is
 * as the cursor's row read it, where the list pages by another value: a time key is the Date the
 * driver read, an Invalid one included, and bytes are a Uint8Array. A value may be a CursorRef: a long sort value
 * carried by reference, its prefix and length, which a keyset of its own must read from the
 * cursor's row (cursor-ref.ts), never bind as it is.
 */
function readCursor(cursor: string, parsedSort: readonly SortField[], options: CursorOptions): DecodedCursor {
	const { read, ...decoded } = readKeyset(cursor, parsedSort, options)
	/* a REAL's text is the row's number, which its read replaces where the row read another (a Date) */
	const values = decoded.values.map((value, i) =>
		read?.[i] ? read[i][0] : value instanceof RealText ? Number(value.text) : value,
	)
	if (read === undefined) return { ...decoded, values }
	return { ...decoded, carried: decoded.carried.map((flag, i) => flag && read[i] === null), values }
}

export {
	CursorRef,
	CURSOR_TIEBREAK_COLUMN,
	MAX_CURSOR_LENGTH,
	cursorBytes,
	cursorProblem,
	effectiveNulls,
	encodeCursor,
	mintCursor,
	readCompared,
	readCursor,
	readKeyset,
	sortSignature,
	type CursorId,
	type CursorOptions,
	type CursorPayload,
	type CursorValue,
	type DecodedCursor,
	openCursor,
}
