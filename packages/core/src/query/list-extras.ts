/**
 * The values of the extras a builder selects for paginate, as a SQLite or Postgres driver reads them:
 * a number, a bigint, or a decimal string (libsql's intMode "string", Q2 of r19). An extra rendered
 * by hand as its own alias reads as that string, which no value of it is (Q4 of r18).
 */
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import { RealText } from "./cursor-codec.ts"
import {
	heldValue,
	isStoredKey,
	isUnprinted,
	STORED_CLASSES,
	isTextKeys,
	textKeysOf,
	unprintedNumber,
} from "./held-keys.ts"
import type { SortField } from "./types.ts"

/** The column every built list selects its tiebreak as, which the next cursor's id is minted from (Q2 of r17) */
const COMB_ID = "_combId" as const

/* an integer from 0 as a SQLite driver writes it in a string (libsql's intMode "string"): canonical, which no alias is */
const DECIMAL: RegExp = /^(?:0|[1-9]\d*)$/
/* an integer as a SQLite driver writes it in a string: canonical, signed */
const INTEGER_TEXT: RegExp = /^-?(?:0|[1-9]\d*)$/
/* the start of a Postgres time's to_json text in any DateStyle: a year of four digits or more and its dash, or ±infinity; no numeric's text, which a custom column carries, starts so */
const TIME_TEXT: RegExp = /^(?:-?infinity$|\d{4,}-)/
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

/* what a Postgres float key carries in `_combKeyTexts` under extra_float_digits 0 or below (AB4-4 of area B) */
const FLOAT_MARK = "!f"

/**
 * The 500 for a SQLite key holding a value of `stored`'s class its mode reads as another, on a list that
 * binds it as read: a timestamp's TEXT, a boolean's value but 0 or 1, a `numeric()`'s ±Infinity or BLOB
 * (AB4-2 of area B), which the read places nowhere a cursor resumes after
 */
const storesUnread = (field: string, stored: string): CombError =>
	new CombError({
		cause: `${field} stores a ${stored.toUpperCase()} value its column's drizzle mode reads as another, which no cursor of a list that binds the key as read resumes after: store what the mode reads back (a timestamp's epoch number, a boolean's 0 or 1, a finite number), or sort by a column of the list's own table`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})

/** The 500 for a SQLite number key no text SQLite prints of reads back as it, which no cursor binds exactly (AB4-7 of area B) */
const printsUnread = (field: string): CombError =>
	new CombError({
		cause: `${field} holds a REAL no text SQLite prints of it reads back as (D1 misprints some past about 1e100 and below 1e-100), which no cursor resumes after: store a number of fewer significant digits, or sort by another column`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})

/** The 500 for a Postgres float key read under extra_float_digits 0 or below: its read is rounded */
const printsRounded = (field: string): CombError =>
	new CombError({
		cause: `${field} is a float Postgres prints rounded under extra_float_digits 0 or below, which no cursor resumes from: leave extra_float_digits at its default of 1, or sort by another column`,
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
	/* a REAL no text reads back as compares as its printf text reads; its cursor refuses (AB4-7 of area B) */
	if (isUnprinted(carried)) return unprintedNumber(carried)
	/* B2-7 of area B: node-postgres reads a time no DateStyle but ISO writes as null, which its stored text replaces */
	if (stored === "time" || typeof value === "number") return carried
	/* AB3-4 of area B: with no classes, a Postgres time's text stands in for any read of it, a string mode's included */
	if (TIME_TEXT.test(carried)) return carried
	return value instanceof Date ? Number(carried) : value
}

/**
 * A 500 naming the first of `sort`'s keys whose stored value the row's `_combKeyTexts` marks as none
 * a list binding it as read places: a SQLite value of a class its mode reads as another, `!` and the
 * class (a timestamp's TEXT, a boolean's value but 0 or 1, AB4-2 of area B); and a Postgres float the session's extra_float_digits prints rounded on any list (AB4-4 of area B).
 * paginate asks it of every row it serves, so the refusal never hangs on which row ends a page
 */
function refuseUnheld(row: Record<string, unknown>, sort: readonly SortField[]): void {
	refuseUnprinted(row, sort)
	refuseUnread(row, sort)
}

/**
 * A 500 naming the first of `sort`'s SQLite REAL keys no text SQLite prints of reads back as, which
 * the row's `_combTextKeys` or `_combKeyTexts` marks `!n`: no cursor resumes after it, so the page
 * that serves the row refuses, and the merge orders it by its printf text
 * (AB4-7 of area B)
 */
function refuseUnprinted(row: Record<string, unknown>, sort: readonly SortField[]): void {
	const held = textKeysOf(row)
	const texts = row["_combKeyTexts"]
	const carried = typeof texts === "string" ? texts.split(",") : []
	const unprinted = sort.find((_, i) => isUnprinted(held?.[i]) || isUnprinted(carried[i]))
	if (unprinted !== undefined) throw printsUnread(unprinted.field)
}

/** refuseUnheld's refusals of a key the row typed (typedKeys) cannot stand for: a class its mode reads as another, a rounded float */
function refuseUnread(row: Record<string, unknown>, sort: readonly SortField[]): void {
	const texts = row["_combKeyTexts"]
	if (typeof texts !== "string") return
	const carried = texts.split(",")
	const unread = sort.findIndex((_, i) => STORED_CLASSES.has(carried[i]?.slice(1)) && carried[i]?.startsWith("!"))
	if (unread !== -1) throw storesUnread((sort[unread] as SortField).field, (carried[unread] as string).slice(1))
	const float = sort.find((_, i) => carried[i] === FLOAT_MARK)
	if (float !== undefined) throw printsRounded(float.field)
}

/**
 * `row` with each sort key, and the tiebreak, as SQLite stored it, by the class `_combKeyTypes`
 * carries: an integer the driver read as a decimal string as that integer (Q2 of r19), so a cursor
 * minted from it compares as one, a string binding as text, which SQLite orders after every
 * integer; a REAL ±Infinity D1's transport read as null as itself (Q3 of r20); a time key its
 * stored value `_combKeyTexts` carries (QL2 of r22b), and a SQLite key holding a value of a class
 * its mode reads as another the value `_combTextKeys` carries: a timestamp's TEXT (B2-3 of area B), a
 * boolean's value but 0 or 1 (AB3-2), a text's integer (AB4-2 of area B). A text key that looks like a number stays
 * text. The merge compares rows through it (Q2 of r20).
 */
function typedKeys(row: Record<string, unknown>, sort: readonly SortField[]): Record<string, unknown> {
	const stored = storedClasses(row)
	const texts = row["_combKeyTexts"]
	const held = textKeysOf(row)
	if (stored === undefined && typeof texts !== "string" && held === undefined) return row
	const carried = typeof texts === "string" ? texts.split(",") : []
	refuseUnread(row, sort)
	const typed = [...sort.map(({ field }) => field), COMB_ID]
		.map((field, i) => {
			const own = held?.[i]
			if (isStoredKey(own)) return [field, heldValue(own)] as const
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
			.filter((field, i) => isStoredKey(held?.[i]) || (typed[field] !== row[field] && typed[field] === carried[i])),
	)
}

/**
 * `typedKeys(row, sort)` as a cursor carries it: each SQLite REAL key's text, held (`_combTextKeys`)
 * or a timestamp's carried (`_combKeyTexts`), as its RealText, which the next page binds as the list
 * checked it (AB4-7 of area B); the merge compares typedKeys' numbers, the same parse of the same text
 */
function cursorKeys(row: Record<string, unknown>, sort: readonly SortField[]): Record<string, unknown> {
	refuseUnprinted(row, sort)
	const typed = typedKeys(row, sort)
	const texts = row["_combKeyTexts"]
	const carried = typeof texts === "string" ? texts.split(",") : []
	const held = textKeysOf(row)
	const reals = sort.flatMap(({ field }, i): Array<readonly [string, RealText]> => {
		const own = held?.[i]
		if (isStoredKey(own)) return own[0] === "real" ? [[field, new RealText(own[1])]] : []
		const text = carried[i]
		/* a ±Infinity carries no text: its class reads it back (Q3 of r20) */
		const seconds = row[field] instanceof Date && typeof typed[field] === "number" && text !== undefined && text !== ""
		return seconds ? [[field, new RealText(text)]] : []
	})
	return reals.length === 0 ? typed : { ...typed, ...Object.fromEntries(reals) }
}

export {
	carriedTexts,
	cursorKeys,
	COMB_ID,
	INTEGER_TEXT,
	type KeyClass,
	malformed,
	refuseUnheld,
	storedClasses,
	typedKeys,
	unencoded,
}
