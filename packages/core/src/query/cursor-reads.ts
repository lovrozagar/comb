/**
 * The value a cursor's row read for each key the keyset binds as another, as the cursor's `d`
 * carries it: one slot per key, null where the two are one, else the read value encoded
 * alone in an array, so a read null (D1's for a REAL ±Infinity) is told from a key read as bound
 * (AB3-3 of area B). A cursor minted before holds a Date's epoch milliseconds, or "invalid" for an
 * Invalid Date, in a slot; both still read.
 */
import { carried, CursorRef, type CursorValue, decodeValue, encodeValue, sameValue } from "./cursor-codec.ts"

/* the Date of a row that holds none, as a cursor minted before AB3-3 writes it */
const INVALID_READ = "invalid"

/** A key's read value, or null for a key read as bound */
type ReadSlot = readonly [CursorValue] | null

/** One key's slot from the wire, or undefined when it is none */
function slotOf(slot: unknown, decode: (slot: unknown) => CursorValue | undefined): ReadSlot | undefined {
	if (slot === null) return null
	if (slot === INVALID_READ) return [new Date(Number.NaN)]
	if (typeof slot === "number") return [new Date(slot)]
	if (!Array.isArray(slot) || slot.length !== 1) return undefined
	const value = decode(slot[0])
	/* a reference stands for a value no row read; the bound carries it */
	return value === undefined || value instanceof CursorRef ? undefined : [value]
}

/**
 * Each key's read value from the wire, decoded by decodePayload's `decode`; none for a cursor that
 * carries none, null for one that is no cursor's
 */
function readOf(
	d: unknown,
	count: number,
	decode: (slot: unknown) => CursorValue | undefined,
): ReadSlot[] | null | undefined {
	if (d === undefined) return undefined
	if (!Array.isArray(d) || d.length !== count) return null
	const read = d.map((slot: unknown) => slotOf(slot, decode))
	return read.includes(undefined) ? null : (read as ReadSlot[])
}

/**
 * The slot a cursor's `d` writes for a key the row read as `read` and the keyset binds as `bound`:
 * null where they are one, or where no cursor carries the read, which readCursor then answers with
 * the bound
 */
function readSlot(read: unknown, bound: unknown): [unknown] | null {
	if (read === undefined) return null
	return sameValue(bound, read) || !carried(read, decodeValue) ? null : [encodeValue(read)]
}

/**
 * The reads of `row`'s sort keys that differ from the values it binds, settled before a long value
 * goes by reference: a key read as bound carries none, so its reference keeps the cursor within the cap
 */
function readsApart(
	read: Record<string, unknown> | undefined,
	row: Record<string, unknown>,
	fields: readonly string[],
): Record<string, unknown> | undefined {
	if (read === undefined) return undefined
	return Object.fromEntries(
		fields.filter((field) => readSlot(read[field], row[field]) !== null).map((field) => [field, read[field]]),
	)
}

export { readOf, readsApart, readSlot, type ReadSlot }
