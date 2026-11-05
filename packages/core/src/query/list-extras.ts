/**
 * The values of the extras a builder selects for paginate, as a SQLite or Postgres driver reads them:
 * a number, a bigint, or a decimal string (libsql's intMode "string", Q2 of r19). An extra rendered
 * by hand as its own alias reads as that string, which no value of it is (Q4 of r18).
 */
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import type { SortField } from "./types.ts"

/** The column every built list selects its tiebreak as, which the next cursor's id is minted from (Q2 of r17) */
const COMB_ID = "_combId" as const

/* an integer from 0 as a SQLite driver writes it in a string (libsql's intMode "string"): canonical, which no alias is */
const DECIMAL: RegExp = /^(?:0|[1-9]\d*)$/
/* an integer as a SQLite driver writes it in a string: canonical, signed */
const INTEGER_TEXT: RegExp = /^-?(?:0|[1-9]\d*)$/
// lookup-table: the storage classes SQLite's typeof() answers with, a REAL ±Infinity as its own (Q3 of r20), and Postgres's families (Q2 of r21)
const KEY_CLASSES: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"+inf",
	"-inf",
	"blob",
	"fixed",
	"float",
	"integer",
	"null",
	"other",
	"real",
	"text",
	"time",
])

/**
 * The class of a list's sort key or tiebreak, as `_combKeyTypes` carries it: SQLite's storage class,
 * or on Postgres its family (`float`, `fixed`, `time`, `other`), which no key's value is read by
 */
type KeyClass = "+inf" | "-inf" | "blob" | "fixed" | "float" | "integer" | "null" | "other" | "real" | "text" | "time"

/** A value as a refusal shows it: a bigint with its n, anything else as JSON */
const shown = (value: unknown): string => (typeof value === "bigint" ? `${value}n` : JSON.stringify(value))

/** `value` as a driver read an integer from 0: a number, a bigint, or a decimal string as its bigint (Q2 of r19) */
const unencoded = (value: unknown): unknown =>
	typeof value === "string" && DECIMAL.test(value) ? BigInt(value) : value

/** Whether `value` is a count: a safe integer from 0, in any encoding a SQLite driver reads one in */
function isCount(encoded: unknown): boolean {
	const value = unencoded(encoded)
	return typeof value === "bigint"
		? value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
		: Number.isSafeInteger(value) && (value as number) >= 0
}

/** Whether `value` is the class of each of `sort`'s keys and of the tiebreak, comma-joined, as the builder selects it */
const isKeyTypes = (value: unknown, sort: readonly SortField[]): boolean =>
	typeof value === "string" &&
	value.split(",").length === sort.length + 1 &&
	value.split(",").every((each) => KEY_CLASSES.has(each))

/** Whether `value` is one stored time per sort key, comma-joined, empty where none is carried, as the builder selects it */
const isKeyTexts = (value: unknown, sort: readonly SortField[]): boolean =>
	typeof value === "string" && value.split(",").length === sort.length

/**
 * The class of each of `sort`'s keys, then the tiebreak's, from the row's `_combKeyTypes`; none where
 * the builder selected none (a table list over columns, or a Postgres one)
 */
function storedClasses(row: Record<string, unknown>): readonly KeyClass[] | undefined {
	const types = row["_combKeyTypes"]
	return typeof types === "string" ? (types.split(",") as KeyClass[]) : undefined
}

/**
 * A blob as the driver read it, as its bytes: libsql reads one no buffer-mode column maps as an
 * ArrayBuffer, and D1 as an array of its bytes
 */
function bytesOf(value: unknown): unknown {
	if (value instanceof ArrayBuffer) return new Uint8Array(value)
	return Array.isArray(value) ? Uint8Array.from(value as number[]) : value
}

/**
 * `value` as SQLite stored it under `stored`: an integer read as a decimal string as that integer, a
 * REAL read as the text of its double (drizzle's `numeric()`, B2-4 of area B) as that double, a
 * ±Infinity read as null (D1) as itself, and a blob as its bytes (bytesOf)
 */
function storedValue(value: unknown, stored: KeyClass | undefined): unknown {
	if (stored === "+inf") return Number.POSITIVE_INFINITY
	if (stored === "-inf") return Number.NEGATIVE_INFINITY
	if (stored === "blob") return bytesOf(value)
	if (typeof value !== "string") return value
	if (stored === "integer" && INTEGER_TEXT.test(value)) return BigInt(value)
	/* only the text JS writes for that very double, so the number is exact */
	return stored === "real" && String(Number(value)) === value ? Number(value) : value
}

/** Whether `value` is the anchor-gone flag as a driver reads it: 0 or 1, as a number, a bigint, a decimal string or a boolean */
function isFlag(value: unknown): boolean {
	const read = unencoded(value)
	return read === 0 || read === 1 || read === 0n || read === 1n || typeof read === "boolean"
}

/** Each extra a builder selects, and whether a value of it is one, in the order malformed names them */
const EXTRA_CHECKS: ReadonlyArray<readonly [string, (value: unknown, sort: readonly SortField[]) => boolean]> = [
	["_total", isCount],
	[COMB_ID, (id) => id !== COMB_ID],
	["_combKeyTypes", isKeyTypes],
	["_combKeyTexts", isKeyTexts],
	["_combTextKeys", isTextKeys],
	["_combAnchorGone", isFlag],
]

/**
 * The extra of `row` whose value no builder selects, as `_total "_total"`; undefined when each is its
 * kind. An extra rendered by hand as its own alias reads as that string (Q4 of r18).
 */
function malformed(row: object, sort: readonly SortField[]): string | undefined {
	const values = row as Record<string, unknown>
	const wrong = EXTRA_CHECKS.find(([extra, valid]) => Object.hasOwn(row, extra) && !valid(values[extra], sort))
	return wrong === undefined ? undefined : `${wrong[0]} ${shown(values[wrong[0]])}`
}

/* what a SQLite timestamp key holding TEXT carries in `_combKeyTexts` on a list that binds it as read (B2-3 of area B) */
const TEXT_MARK = "!"

/**
 * Whether `value` is `_combTextKeys` as a builder selects it for `sort`: a JSON array, a TEXT or null
 * a key, or empty where listOptions' table has no key that holds TEXT
 */
function isTextKeys(value: unknown, sort: readonly SortField[]): boolean {
	if (typeof value !== "string") return false
	if (value === "") return true
	try {
		const keys: unknown = JSON.parse(value)
		return (
			Array.isArray(keys) && keys.length === sort.length && keys.every((key) => key === null || typeof key === "string")
		)
	} catch {
		// reason: a value that is no JSON, such as the alias rendered by hand, is no _combTextKeys, which malformed names
		return false
	}
}

/** Each sort key's TEXT from the row's `_combTextKeys`, null for a key holding none; none where no key holds any */
const textKeysOf = (row: Record<string, unknown>): readonly (string | null)[] | undefined =>
	typeof row["_combTextKeys"] === "string" && row["_combTextKeys"] !== ""
		? (JSON.parse(row["_combTextKeys"]) as (string | null)[])
		: undefined

/** The 500 for a SQLite timestamp key holding TEXT on a list that binds it as read: no cursor binds a Date past it */
const storesText = (field: string): CombError =>
	new CombError({
		cause: `${field} stores TEXT, which no Date cursor binds: store the epoch time as a number, as unixepoch() does, not CURRENT_TIMESTAMP's text`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})

/**
 * A time key's value as the row stores it, where the builder carried it (QL2 of r22b): the Date the
 * driver read keeps milliseconds, where Postgres keeps microseconds and SQLite's seconds any fraction.
 * A Postgres time key's text, which Postgres reads back as the key's own type, or SQLite's REAL seconds
 */
function storedText(value: unknown, stored: KeyClass | undefined, carried: string | undefined): unknown {
	if (carried === undefined || carried === "") return value
	if (typeof value === "number") return carried
	if (!(value instanceof Date)) return value
	return stored === "time" ? carried : Number(carried)
}

/**
 * `row` with each sort key, and the tiebreak, as SQLite stored it, by the class `_combKeyTypes`
 * carries: an integer the driver read as a decimal string as that integer (Q2 of r19), so a cursor
 * minted from it compares as one, a string binding as text, which SQLite orders after every
 * integer; a REAL ±Infinity D1's transport read as null as itself (Q3 of r20); a time key its
 * stored value `_combKeyTexts` carries (QL2 of r22b), and a SQLite timestamp holding TEXT the TEXT
 * `_combTextKeys` carries (B2-3 of area B). A text key that looks like a number stays
 * text. The merge compares rows through it (Q2 of r20).
 */
function typedKeys(row: Record<string, unknown>, sort: readonly SortField[]): Record<string, unknown> {
	const stored = storedClasses(row)
	const texts = row["_combKeyTexts"]
	const held = textKeysOf(row)
	if (stored === undefined && typeof texts !== "string" && held === undefined) return row
	const carried = typeof texts === "string" ? texts.split(",") : []
	const text = sort.find((_, i) => carried[i] === TEXT_MARK)
	if (text !== undefined) throw storesText(text.field)
	const typed = [...sort.map(({ field }) => field), COMB_ID]
		.map((field, i) => {
			const own = held?.[i]
			if (typeof own === "string") return [field, own] as const
			const value = stored === undefined ? row[field] : storedValue(row[field], stored[i])
			return [field, storedText(value, stored?.[i], carried[i])] as const
		})
		.filter(([field, value]) => value !== row[field])
	return typed.length === 0 ? row : { ...row, ...Object.fromEntries(typed) }
}

/**
 * The sort fields whose value in `typedKeys(row, sort)` is the stored text `_combKeyTexts` or `_combTextKeys` carried in
 * place of the value as read (comb-9d's AB2 ruling), which a cursor binds as itself, past the
 * column's mapper; every other key binds through it, a text key that looks like a number included
 */
function carriedTexts(row: Record<string, unknown>, sort: readonly SortField[]): Set<string> {
	const texts = row["_combKeyTexts"]
	const held = textKeysOf(row)
	if (typeof texts !== "string" && held === undefined) return new Set()
	const carried = typeof texts === "string" ? texts.split(",") : []
	const typed = typedKeys(row, sort)
	return new Set(
		sort
			.map(({ field }) => field)
			.filter(
				(field, i) => typeof held?.[i] === "string" || (typed[field] !== row[field] && typed[field] === carried[i]),
			),
	)
}

export { carriedTexts, COMB_ID, INTEGER_TEXT, type KeyClass, malformed, storedClasses, typedKeys, unencoded }
