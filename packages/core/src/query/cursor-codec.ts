/**
 * A cursor's values on the wire: each sort value and the tiebreak id as JSON, the values JSON has
 * no form for under a one-key tag, and back. Closed: what a mint encodes, the decoder returns as
 * itself (QL5 of r22b), and any other value is no cursor's, which `carried` tells a mint.
 */
import { decodeBase64Url, encodeBase64Url } from "./base64url.ts"

/** The tiebreak id as the row held it: a number stays a number, a bigint a bigint, so it compares as one */
type CursorId = bigint | number | string

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
type CursorValue = bigint | boolean | CursorRef | Date | number | string | Uint8Array | null

/* Dates survive JSON as tagged epoch ms so a timestamp column compares as one, a bigint as its
   decimal digits, a number JSON has none for (±Infinity, NaN) as its name, not as null, and a
   blob's bytes as base64url (QL5 of r22b) */
const BYTES_TAG = "$bytes"
const DATE_TAG = "$date"
const BIGINT_TAG = "$bigint"
const NUM_TAG = "$num"
const REF_TAG = "$ref"
const NON_FINITE = ["Infinity", "-Infinity", "NaN"]

function encodeValue(value: unknown): unknown {
	/* a Date no JS Date holds, a date-mode ±infinity, stays a Date: null under the tag, never the null group (3.24) */
	if (value instanceof Date) return { [DATE_TAG]: Number.isNaN(value.getTime()) ? null : value.getTime() }
	if (value instanceof CursorRef) return { [REF_TAG]: [value.prefix, value.length] }
	if (value instanceof Uint8Array) return { [BYTES_TAG]: encodeBase64Url(value) }
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

/** A tagged value from the wire: a Date a JS Date can hold, a bigint of decimal digits, ±Infinity or NaN, bytes, or a reference */
function decodeTagged(value: Record<string, unknown>): CursorRef | Date | Uint8Array | bigint | number | undefined {
	if (Object.hasOwn(value, REF_TAG)) return decodeRef(value[REF_TAG])
	if (Object.hasOwn(value, BYTES_TAG)) {
		const bytes = value[BYTES_TAG]
		return typeof bytes === "string" ? (decodeBase64Url(bytes) ?? undefined) : undefined
	}
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

/** Whether `back`, what a cursor read back, is `value` itself: the same bytes, time, reference or value */
function sameValue(value: unknown, back: unknown): boolean {
	if (value instanceof Uint8Array)
		return back instanceof Uint8Array && back.length === value.length && value.every((byte, i) => byte === back[i])
	if (value instanceof Date) return back instanceof Date && Object.is(back.getTime(), value.getTime())
	if (value instanceof CursorRef)
		return back instanceof CursorRef && back.prefix === value.prefix && back.length === value.length
	/* -0 reads back as 0, which every database compares as equal */
	return value === back || (Number.isNaN(value) && Number.isNaN(back))
}

/** Whether a cursor carries `value` as itself: `decode` reads its encoding back as it */
function carried(value: unknown, decode: (wire: unknown) => unknown): boolean {
	const json = JSON.stringify(encodeValue(value))
	return json !== undefined && sameValue(value, decode(JSON.parse(json)))
}

export { carried, CursorRef, decodeId, decodeValue, encodeValue, type CursorId, type CursorValue }
