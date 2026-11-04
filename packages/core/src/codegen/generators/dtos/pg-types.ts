/**
 * The rule a write DTO gives a plain Postgres column by its data type (F50): what Postgres takes
 * for that type, as a zod check can say it, so a value the database would refuse is a 400 here
 * rather than a 22P02 from the insert. A rule is stricter than Postgres only for a spelling the
 * 0.14 changelog lists. A read DTO keeps the plain type, as a read never refuses a stored row (F65).
 */
import type { FieldMeta } from "../../analyzer-types.ts"
import { inetRule } from "./ip-patterns.ts"

/**
 * A Postgres type's modifier, parsed once from drizzle's `getSQLType()` so every rule reads the
 * same value and none matches the text (CD5, CD6 of r22b): a time's precision and zone, a
 * numeric's precision and signed scale (Postgres 15 takes a scale past the precision, or below 0),
 * an interval's last field and precision, a bit string's length
 */
export type PgModifier =
	| { base: "bit"; length: number }
	| { base: "interval"; field: IntervalField | null; precision: number | null }
	| { base: "numeric"; precision: number | null; scale: number }
	| { base: "time" | "timestamp"; precision: number | null; withTimeZone: boolean }
	| { base: "other" }

/** An interval's last field, below which Postgres drops every part without an error */
type IntervalField = "day" | "hour" | "minute" | "month" | "second" | "year"

const INTERVAL_FIELDS =
	/^interval(?: (year|month|day|hour|minute|second)(?: to (month|hour|minute|second))?)?(?:\((\d+)\))?$/

/** The modifier drizzle's SQL type `sqlType` declares; a type comb reads none of is `other` */
export function pgModifierOf(sqlType: string): PgModifier {
	/* drizzle writes `timestamp (3)` in one mode and `timestamp(3)` in another */
	const time = /^(time|timestamp) ?(?:\((\d+)\))?( with time zone)?$/.exec(sqlType)
	if (time !== null)
		return {
			base: time[1] as "time" | "timestamp",
			precision: time[2] === undefined ? null : Number(time[2]),
			withTimeZone: time[3] !== undefined,
		}
	const numeric = /^numeric(?:\((\d+)(?:, ?(-?\d+))?\))?$/.exec(sqlType)
	if (numeric !== null)
		return {
			base: "numeric",
			precision: numeric[1] === undefined ? null : Number(numeric[1]),
			scale: Number(numeric[2] ?? 0),
		}
	const interval = INTERVAL_FIELDS.exec(sqlType)
	if (interval !== null)
		return {
			base: "interval",
			field: (interval[2] ?? interval[1] ?? null) as IntervalField | null,
			precision: interval[3] === undefined ? null : Number(interval[3]),
		}
	const bit = /^bit\((\d+)\)$/.exec(sqlType)
	return bit === null ? { base: "other" } : { base: "bit", length: Number(bit[1]) }
}

/** The modifier of `sqlType`, which a rule keyed by its data type knows is of `base` */
function modifierAs<B extends PgModifier["base"]>(sqlType: string, base: B): Extract<PgModifier, { base: B }> {
	const modifier = pgModifierOf(sqlType)
	if (modifier.base !== base) throw new TypeError(`comb reads no ${base} modifier in ${sqlType}`)
	return modifier as Extract<PgModifier, { base: B }>
}

/*
 * an offset as RFC 3339 writes one, Z or ±hh:mm, as JSON Schema's time and date-time formats and
 * z.iso.datetime take it, its hours at most 15 as Postgres holds one (F4 of the 0.14.1 review): the
 * one source a timetz and a timestamptz read, so they take one spelling (CD11 of r22b)
 */
const OFFSET = "(?:Z|[+-](?:0[0-9]|1[0-5]):[0-5][0-9])"

/*
 * zod's ISO date, date-time and time regexes, each \d written as [0-9] and nothing else changed (a test
 * holds each copy to zod's own, read as it runs): zod's publish \d, which Rust's regex reads as any
 * Unicode digit, so comb publishes its own, which ECMAScript, Go's RE2 and Rust's regex read alike
 * (AA7 of r22). Each is a z.stringFormat of zod's format name, which checks and publishes the regex it
 * is given: zod's types refuse a `pattern` param on z.iso.*, which a consumer's tsc reads
 */
const ISO_DATE =
	"(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))"
const ISO_CLOCK = "(?:[01][0-9]|2[0-3]):[0-5][0-9]"
const ISO_SECOND = "(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?"
const ISO_WALL = `${ISO_CLOCK}(?::[0-5][0-9](?:\\.[0-9]+)?)?`
const ISO_TIME = `^${ISO_WALL}$`
const ISO_LOCAL = `^${ISO_DATE}T(?:${ISO_SECOND}(?:Z)|${ISO_WALL})$`
const ISO_OFFSET = `^${ISO_DATE}T(?:${ISO_SECOND}(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$`

/** A second's fraction of at most `precision` digits, any length for none, as a regex piece */
const fractionOf = (precision: number | null): string =>
	precision === null ? "(?:\\.[0-9]+)?" : precision === 0 ? "" : `(?:\\.[0-9]{1,${precision}})?`

/** Why a fraction past `precision` digits is refused: Postgres would round it, maybe into the next day */
const roundedBy = (type: string, precision: number): string =>
	precision === 0
		? `Must have no fraction of a second, which ${type}(0) would round`
		: `Must have at most ${precision} digits after the second's point, which ${type}(${precision}) would round`

/**
 * A time's fraction held to its precision, checked at the end of the value, before `tail` (its
 * offset, if any): its last two digits not after a point, or a fraction of at most `precision`
 * digits. A refine of no lookaround, which every regex engine reads
 */
function fractionRule(type: string, precision: number | null, tail: string): string {
	if (precision === null) return ""
	const fraction = precision === 0 ? "" : `|\\.[0-9]{1,${precision}}`
	return `.regex(/(?:[^.0-9][0-9][0-9]${fraction})${tail}$/u, { message: "${roundedBy(type, precision)}" })`
}

/* a time with an offset, which z.iso.time does not take: hh:mm[:ss[.f]], then the offset (F4 of the 0.14.1 review) */
const timetz = (precision: number | null): string =>
	`z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9]${fractionOf(precision)})?${OFFSET}$/u${precision === null ? "" : `, { message: "Must be a time with an offset${precision === 0 ? " and no fraction of a second" : ` and at most ${precision} digits after the second's point`}, which time(${precision}) with time zone would round" }`})`

/*
 * A timestamp keeps no zone: given an offset or Z it discards it, so the instant is lost. A
 * timestamptz given a local time reads it in the session's TimeZone, so the instant depends on
 * the server's config. Each takes only the form whose instant it keeps, and a precision rounds a
 * longer fraction, perhaps into the next day, so each takes none (CD6 of r22b).
 */
function timestampRule({ precision, withTimeZone }: { precision: number | null; withTimeZone: boolean }): string {
	const type = withTimeZone ? "timestamp with time zone" : "timestamp"
	if (!withTimeZone)
		return `z.stringFormat("datetime", /${ISO_LOCAL}/u).regex(/[^Zz]$/u, { message: "Must be a local date-time, with no offset or Z, which timestamp would discard" })${fractionRule(type, precision, "")}`
	return `z.stringFormat("datetime", /${ISO_OFFSET}/u).regex(/${OFFSET}$/u, { message: "Must have an offset of at most 15:59, as Postgres holds one" })${fractionRule(type, precision, OFFSET)}`
}

/** A time, local or with its offset, its fraction held to its precision (CD5, CD6 of r22b) */
function timeRule({ precision, withTimeZone }: { precision: number | null; withTimeZone: boolean }): string {
	return withTimeZone
		? timetz(precision)
		: `z.stringFormat("time", /${ISO_TIME}/u)${fractionRule("time", precision, "")}`
}

/* an ISO 8601 duration as z.iso.duration takes one, with no lookaround, so RE2 compiles it (CS3 of
 * r22b): weeks alone, or at least one date or time part, the seconds alone taking a fraction. Its
 * decimal mark is `.` alone, as Postgres refuses ISO 8601's comma with a 22007 (AA6 of r22) */
const SECONDS = "[0-9]+(?:\\.[0-9]+)?S"
const TIME_PART = `T(?:[0-9]+H(?:[0-9]+M)?(?:${SECONDS})?|[0-9]+M(?:${SECONDS})?|${SECONDS})`
const DURATION = `^P(?:[0-9]+W|(?:[0-9]+Y(?:[0-9]+M)?(?:[0-9]+D)?|[0-9]+M(?:[0-9]+D)?|[0-9]+D)(?:${TIME_PART})?|${TIME_PART})$`

// lookup-table: the ISO 8601 duration an interval's last field keeps, as a regex of no lookaround
const KEPT_BY: Readonly<Record<Exclude<IntervalField, "second">, string>> = {
	day: "^P[^T]*$",
	hour: "^P[^T]*(?:T[0-9]+H)?$",
	minute: "^P[^T]*(?:T(?:[0-9]+H)?(?:[0-9]+M)?)?$",
	month: "^P(?:[0-9]+Y)?(?:[0-9]+M)?$",
	year: "^P[0-9]+Y$",
}

/**
 * An interval: an ISO 8601 duration with no part below its last field, which Postgres drops
 * (`PT1H` into an `interval day` is stored as 0), and no fraction of a second past its precision,
 * which it rounds (CD6 of r22b). A string and its pattern, with no `format: "duration"`: that format
 * is RFC 3339's, whose seconds take no fraction, where Postgres keeps one (AA10 of r22). Its precision
 * is never 0: drizzle writes `precision: 0` as no precision, which a test holds
 */
function intervalRule({ field, precision }: { field: IntervalField | null; precision: number | null }): string {
	const fields =
		field === null || field === "second"
			? ""
			: `.regex(/${KEPT_BY[field]}/u, { message: "Must hold no part below its ${field}s, which an interval of ${field}s drops" })`
	const fraction =
		precision === null
			? ""
			: `.regex(/^[^.]*(?:\\.[0-9]{1,${precision}}S)?$/u, { message: "${roundedBy("interval", precision)}" })`
	return `z.string().regex(/${DURATION}/u, { message: "Must be an ISO 8601 duration" })${fields}${fraction}`
}

/**
 * A numeric as text: its digits, within its precision and scale (CD5 of r22b). Postgres rounds a
 * longer fraction first, which may carry it past the precision (999.995 into numeric(5,2) is a
 * 22003), so the DTO takes none. A scale past the precision leaves a fraction alone, its first
 * scale - precision digits zeros; a scale below 0 a whole number whose last -scale digits are zeros
 */
function numericText(sqlType: string): string {
	const { precision, scale } = modifierAs(sqlType, "numeric")
	if (precision === null) return "z.string().regex(/^-?[0-9]+(?:\\.[0-9]+)?$/u)"
	if (scale < 0)
		return `z.string().regex(/^-?0*(?:[0-9]{1,${precision}}0{${-scale}}|0)$/u, { message: "Must be a whole number of at most ${precision} digits then ${-scale} zeros, which numeric(${precision}, ${scale}) holds unrounded" })`
	if (scale > precision)
		return `z.string().regex(/^-?0+(?:\\.(?:0{1,${scale}}|0{${scale - precision}}[0-9]{1,${precision}}))?$/u, { message: "Must be a number below 10^${precision - scale} of at most ${scale} digits after the point" })`
	const whole = precision - scale === 0 ? "0" : `[0-9]{1,${precision - scale}}`
	const fraction = scale === 0 ? "" : `(?:\\.[0-9]{1,${scale}})?`
	return `z.string().regex(/^-?0*${whole}${fraction}$/u, { message: "Must be a number of at most ${precision - scale} digits before the point and ${scale} after it" })`
}

/**
 * A numeric read in drizzle's number mode: below 10^(precision - scale) in magnitude by at least
 * half its last place, so Postgres's rounding keeps it within the precision, whatever the scale's sign
 */
function numericNumber(sqlType: string): string | undefined {
	const { precision, scale } = modifierAs(sqlType, "numeric")
	if (precision === null) return undefined
	const bound = 10 ** (precision - scale) - 5 * 10 ** -(scale + 1)
	return `z.number().gt(${-bound}).lt(${bound})`
}

/** A digit string as long as `limit` and not above it: `limit` itself, or a smaller digit where the two first part */
function notAbove(limit: string): string {
	const below = [...limit].flatMap((digit, at) =>
		digit === "0" ? [] : [`${limit.slice(0, at)}[0-${Number(digit) - 1}][0-9]{${limit.length - at - 1}}`],
	)
	return [...below, limit].join("|")
}

/* a bigint in drizzle's string mode: decimal digits within int8's range, as one pattern a JSON
   Schema reader applies too (CS8 of r22b): at most 18 significant digits, or 19 not past the bound */
const int64Text = (): string =>
	`z.string().regex(/^(?:0*(?:[0-9]{1,18}|${notAbove("9223372036854775807")})|-0*(?:[0-9]{1,18}|${notAbove("9223372036854775808")}))$/u, { message: "Must be a whole number within bigint's range, -2^63 to 2^63 - 1" })`

/*
 * float4 holds magnitudes up to 3.4028235e38, and refuses a value that rounds to zero: at or below
 * half its smallest subnormal, 2^-150 (1e-45 rounds up to 1.4e-45 and is taken; 1e-50 is not)
 */
const REAL =
	'z.number().min(-3.4028235e38).max(3.4028235e38).refine((val) => val === 0 || globalThis.Math.abs(val) > 7.006492321624085e-46, { message: "Must be zero or above 2^-150 in magnitude, which real would round to zero" }).meta({ not: { minimum: -7.006492321624085e-46, maximum: 7.006492321624085e-46, not: { const: 0 } } })'

/** The shared schema a cidr's rule is, which the entity file imports */
export const CIDR = "cidrSchema"

/*
 * The spellings Postgres takes for a MAC address. A macaddr: octets of one or two hex digits each,
 * all split by `:` or all by `-`; two halves of six digits; groups of four split by `.` or `-`; or
 * the digits bare. A macaddr8 reads two digits an octet, and one separator, `:`, `-` or `.`, at
 * any of the gaps between them or at none; it takes eight octets, or six, which it widens with ff:fe
 * (AA5 of r22). Its case is written into the classes and each separator is its own branch, as JSON
 * Schema publishes no flag and RE2 takes no backreference (CS2 of r22b)
 */
const HEX = "[0-9A-Fa-f]"
const OCTET = `${HEX}{1,2}`
const PAIR = `${HEX}{2}`
const QUAD = `${HEX}{4}`

/** `group`, then a separator and `group` again `rest` times: one branch per separator of `separators` */
const splitBy = (separators: string[], group: string, rest: string): string[] =>
	separators.map((separator) => `${group}(?:${separator}${group})${rest}`)

const macRegex = (message: string, branches: string[]): string =>
	`z.string().regex(/^(?:${branches.join("|")})$/u, { message: "${message}" })`

const macaddr = (): string =>
	macRegex("Must be a MAC address of six octets", [
		...splitBy([":", "-"], OCTET, "{5}"),
		`${HEX}{6}[:-]${HEX}{6}`,
		...splitBy(["\\.", "-"], QUAD, "{2}"),
		`${HEX}{12}`,
	])
const macaddr8 = (): string =>
	macRegex(
		"Must be a MAC address of six or eight octets",
		[":", "-", "\\."].map((separator) => `${PAIR}(?:${separator}?${PAIR}){5}(?:(?:${separator}?${PAIR}){2})?`),
	)

/** A bit(n) string, drizzle's bit always declaring n: exactly n bits, as an insert takes it (a cast pads or cuts) */
function bitString(sqlType: string): string {
	const { length } = modifierAs(sqlType, "bit")
	return `z.string().regex(/^[01]{${length}}$/u, { message: "Must be exactly ${length} bits" })`
}

/* each data type drizzle gives a Postgres column, and its rule */
// lookup-table: a data type's write rule
const RULES: Readonly<Record<string, (field: FieldMeta) => string | undefined>> = {
	number: ({ sqlType }) => numericNumber(sqlType),
	"number float": () => REAL,
	"string binary": ({ sqlType }) => bitString(sqlType),
	"string cidr": () => CIDR,
	"string date": () => `z.stringFormat("date", /^${ISO_DATE}$/u)`,
	/* an inet a host address, its netmask optional; a cidr the shared cidrSchema, which also refuses a bit set past its prefix length */
	"string inet": inetRule,
	"string interval": ({ sqlType }) => intervalRule(modifierAs(sqlType, "interval")),
	"string macaddr": macaddr,
	"string macaddr8": macaddr8,
	"string int64": int64Text,
	"string numeric": ({ sqlType }) => numericText(sqlType),
	"string time": ({ sqlType }) => timeRule(modifierAs(sqlType, "time")),
	"string timestamp": ({ sqlType }) => timestampRule(modifierAs(sqlType, "timestamp")),
	/* the canonical spelling, as README says (F3 of the 0.14.1 review) */
	"string uuid": () => "z.guid()",
}

/** The write rule of a plain Postgres column of `field`'s data type; undefined when the plain type is its rule */
export function pgWriteRule(field: FieldMeta): string | undefined {
	return Object.hasOwn(RULES, field.dataType)
		? (RULES[field.dataType] as (field: FieldMeta) => string | undefined)(field)
		: undefined
}
