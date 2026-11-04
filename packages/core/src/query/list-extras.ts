/**
 * The values of the extras a builder selects for paginate, as a SQLite or Postgres driver reads them:
 * a number, a bigint, or a decimal string (libsql's intMode "string", Q2 of r19). An extra rendered
 * by hand as its own alias reads as that string, which no value of it is (Q4 of r18).
 */
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

/** `value` as SQLite stored it under `stored`: an integer read as a decimal string as that integer, a ±Infinity read as null (D1) as itself */
function storedValue(value: unknown, stored: KeyClass | undefined): unknown {
	if (stored === "+inf") return Number.POSITIVE_INFINITY
	if (stored === "-inf") return Number.NEGATIVE_INFINITY
	return stored === "integer" && typeof value === "string" && INTEGER_TEXT.test(value) ? BigInt(value) : value
}

/**
 * The extra of `row` whose value no builder selects, as `_total "_total"`; undefined when each is its
 * kind. An extra rendered by hand as its own alias reads as that string (Q4 of r18).
 */
function malformed(row: object, sort: readonly SortField[]): string | undefined {
	const { _combAnchorGone: gone, _combId: id, _combKeyTypes: types, _total: total } = row as Record<string, unknown>
	if (Object.hasOwn(row, "_total") && !isCount(total)) return `_total ${shown(total)}`
	if (Object.hasOwn(row, COMB_ID) && id === COMB_ID) return `${COMB_ID} ${shown(id)}`
	if (Object.hasOwn(row, "_combKeyTypes") && !isKeyTypes(types, sort)) return `_combKeyTypes ${shown(types)}`
	const times = (row as Record<string, unknown>)["_combKeyTexts"]
	if (Object.hasOwn(row, "_combKeyTexts") && !isKeyTexts(times, sort)) return `_combKeyTexts ${shown(times)}`
	const read = unencoded(gone)
	const flag = read === 0 || read === 1 || read === 0n || read === 1n || typeof read === "boolean"
	return Object.hasOwn(row, "_combAnchorGone") && !flag ? `_combAnchorGone ${shown(gone)}` : undefined
}

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
 * stored value `_combKeyTexts` carries (QL2 of r22b). A text key that looks like a number stays
 * text. The merge compares rows through it (Q2 of r20).
 */
function typedKeys(row: Record<string, unknown>, sort: readonly SortField[]): Record<string, unknown> {
	const stored = storedClasses(row)
	const texts = row["_combKeyTexts"]
	if (stored === undefined && typeof texts !== "string") return row
	const carried = typeof texts === "string" ? texts.split(",") : []
	const typed = [...sort.map(({ field }) => field), COMB_ID]
		.map((field, i) => {
			const value = stored === undefined ? row[field] : storedValue(row[field], stored[i])
			return [field, storedText(value, stored?.[i], carried[i])] as const
		})
		.filter(([field, value]) => value !== row[field])
	return typed.length === 0 ? row : { ...row, ...Object.fromEntries(typed) }
}

/**
 * The sort fields whose value in `typedKeys(row, sort)` is the stored text `_combKeyTexts` carried in
 * place of the value as read (comb-9d's AB2 ruling), which a cursor binds as itself, past the
 * column's mapper; every other key binds through it, a text key that looks like a number included
 */
function carriedTexts(row: Record<string, unknown>, sort: readonly SortField[]): Set<string> {
	const texts = row["_combKeyTexts"]
	if (typeof texts !== "string") return new Set()
	const carried = texts.split(",")
	const typed = typedKeys(row, sort)
	return new Set(
		sort.map(({ field }) => field).filter((field, i) => typed[field] !== row[field] && typed[field] === carried[i]),
	)
}

export { carriedTexts, COMB_ID, INTEGER_TEXT, type KeyClass, malformed, storedClasses, typedKeys, unencoded }
