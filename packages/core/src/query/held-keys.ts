/**
 * The stored values a SQLite list selects apart from its keys' reads (`_combTextKeys`), where a key's
 * mode reads a class it holds as another (AB4-2 of area B), and the mark of a REAL SQLite prints no
 * text of that reads back as it (AB4-7 of area B)
 */
import type { SortField } from "./types.ts"

/* what a SQLite number key carries before its printf text where SQLite prints no text of it that reads back as it (AB4-7 of area B) */
const UNPRINTED_MARK = "!n"
type Unprinted = `${typeof UNPRINTED_MARK}${string}`

/** Whether `key` is a carried or held key SQLite printed no text of that reads back (UNPRINTED_MARK) */
const isUnprinted = (key: unknown): key is Unprinted => typeof key === "string" && key.startsWith(UNPRINTED_MARK)

/** An unprinted key's number, as its printf text reads, which the merge orders it by (AB4-7 of area B) */
const unprintedNumber = (key: Unprinted): number => Number(key.slice(UNPRINTED_MARK.length))

/** A key's stored value `_combTextKeys` carries where its mode reads another: its storage class and text, or a REAL's Unprinted */
type HeldKey = readonly [StoredClass, string] | Unprinted | null
type StoredClass = "blob" | "integer" | "real" | "text"
// lookup-table: the storage classes a SQLite key's stored value carries, in _combTextKeys and as `!` and the class in _combKeyTexts (AB4-2 of area B)
const STORED_CLASSES: ReadonlySet<unknown> = /* @__PURE__ */ new Set(["blob", "integer", "real", "text"])

/** Whether `key` is one key's value in `_combTextKeys`: null, or a storage class and its text */
const isHeldKey = (key: unknown): key is HeldKey =>
	key === null ||
	isUnprinted(key) ||
	(Array.isArray(key) && key.length === 2 && STORED_CLASSES.has(key[0]) && typeof key[1] === "string")

/** Whether a held key is a stored value, its class and text: neither null nor Unprinted */
const isStoredKey = (key: HeldKey | undefined): key is readonly [StoredClass, string] => Array.isArray(key)

/**
 * Whether `value` is `_combTextKeys` as a builder selects it for `sort`: a JSON array of a held key
 * each (isHeldKey), or empty where listOptions' table has no key that holds one
 */
function isTextKeys(value: unknown, sort: readonly SortField[]): boolean {
	if (typeof value !== "string") return false
	if (value === "") return true
	try {
		const keys: unknown = JSON.parse(value)
		return Array.isArray(keys) && keys.length === sort.length && keys.every(isHeldKey)
	} catch {
		// reason: a value that is no JSON, such as the alias rendered by hand, is no _combTextKeys, which malformed names
		return false
	}
}

/** Each sort key's held value from the row's `_combTextKeys`, null for a key holding none; none where no key holds any */
const textKeysOf = (row: Record<string, unknown>): readonly HeldKey[] | undefined =>
	typeof row["_combTextKeys"] === "string" && row["_combTextKeys"] !== ""
		? (JSON.parse(row["_combTextKeys"]) as HeldKey[])
		: undefined

/**
 * A held key as the cursor carries it: a stored integer as a number, or a bigint past 2^53, a REAL as
 * its double (9e999 as Infinity), a TEXT itself and a blob as its bytes
 */
function heldValue(key: readonly [StoredClass, string]): unknown {
	const [stored, text] = key
	if (stored === "integer") return Number.isSafeInteger(Number(text)) ? Number(text) : BigInt(text)
	if (stored === "real") return Number(text)
	return stored === "blob" ? Uint8Array.from(text.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16)) : text
}

export { heldValue, isStoredKey, isTextKeys, isUnprinted, STORED_CLASSES, textKeysOf, unprintedNumber }
