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
// lookup-table: the storage classes SQLite's typeof() answers with
const STORAGE: ReadonlySet<string> = /* @__PURE__ */ new Set(["blob", "integer", "null", "real", "text"])

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

/** Whether `value` is the storage class of each of `sort`'s keys, comma-joined, as the builder selects it */
const isKeyTypes = (value: unknown, sort: readonly SortField[]): boolean =>
	typeof value === "string" &&
	value.split(",").length === sort.length &&
	value.split(",").every((each) => STORAGE.has(each))

/**
 * The extra of `row` whose value no builder selects, as `_total "_total"`; undefined when each is its
 * kind. An extra rendered by hand as its own alias reads as that string (Q4 of r18).
 */
function malformed(row: object, sort: readonly SortField[]): string | undefined {
	const { _combAnchorGone: gone, _combId: id, _combKeyTypes: types, _total: total } = row as Record<string, unknown>
	if (Object.hasOwn(row, "_total") && !isCount(total)) return `_total ${shown(total)}`
	if (Object.hasOwn(row, COMB_ID) && id === COMB_ID) return `${COMB_ID} ${shown(id)}`
	if (Object.hasOwn(row, "_combKeyTypes") && !isKeyTypes(types, sort)) return `_combKeyTypes ${shown(types)}`
	const read = unencoded(gone)
	const flag = read === 0 || read === 1 || read === 0n || read === 1n || typeof read === "boolean"
	return Object.hasOwn(row, "_combAnchorGone") && !flag ? `_combAnchorGone ${shown(gone)}` : undefined
}

/**
 * `row` with each sort key SQLite stored as an integer, which the driver read as a decimal string, as
 * that integer, so a cursor minted from it compares as one: a string binds as text, which SQLite
 * orders after every integer (Q2 of r19). A text key that looks like a number stays text.
 */
function typedKeys(row: Record<string, unknown>, sort: readonly SortField[]): Record<string, unknown> {
	const types = row["_combKeyTypes"]
	if (typeof types !== "string") return row
	const stored = types.split(",")
	const integers = sort.filter(({ field }, i) => {
		const value = row[field]
		return stored[i] === "integer" && typeof value === "string" && INTEGER_TEXT.test(value)
	})
	return integers.length === 0
		? row
		: { ...row, ...Object.fromEntries(integers.map(({ field }) => [field, BigInt(row[field] as string)])) }
}

export { COMB_ID, INTEGER_TEXT, malformed, typedKeys, unencoded }
