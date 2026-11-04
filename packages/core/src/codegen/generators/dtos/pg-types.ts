/**
 * The rule a write DTO gives a plain Postgres column by its data type (F50): what Postgres takes
 * for that type, as a zod check can say it, so a value the database would refuse is a 400 here
 * rather than a 22P02 from the insert. A rule is stricter than Postgres only for a spelling the
 * 0.14 changelog lists. A read DTO keeps the plain type, as a read never refuses a stored row (F65).
 */
import type { FieldMeta } from "../../analyzer-types.ts"

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

/* an offset as Postgres holds one: Z, ±hh or ±hh[:]mm, its hours at most 15 (F4 of the 0.14.1 review) */
const OFFSET = "(?:Z|[+-](?:0\\d|1[0-5])(?::?[0-5]\\d)?)"

/** A second's fraction of at most `precision` digits, any length for none, as a regex piece */
const fractionOf = (precision: number | null): string =>
	precision === null ? "(?:\\.\\d+)?" : precision === 0 ? "" : `(?:\\.\\d{1,${precision}})?`

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
	const fraction = precision === 0 ? "" : `|\\.\\d{1,${precision}}`
	return `.regex(/(?:[^.\\d]\\d\\d${fraction})${tail}$/u, { message: "${roundedBy(type, precision)}" })`
}

/* a time with an offset, which z.iso.time does not take: hh:mm[:ss[.f]], then the offset (F4 of the 0.14.1 review) */
const timetz = (precision: number | null): string =>
	`z.string().regex(/^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d${fractionOf(precision)})?${OFFSET}$/u${precision === null ? "" : `, { message: "Must be a time with an offset${precision === 0 ? " and no fraction of a second" : ` and at most ${precision} digits after the second's point`}, which time(${precision}) with time zone would round" }`})`

/*
 * A timestamp keeps no zone: given an offset or Z it discards it, so the instant is lost. A
 * timestamptz given a local time reads it in the session's TimeZone, so the instant depends on
 * the server's config. Each takes only the form whose instant it keeps, and a precision rounds a
 * longer fraction, perhaps into the next day, so each takes none (CD6 of r22b).
 */
function timestampRule({ precision, withTimeZone }: { precision: number | null; withTimeZone: boolean }): string {
	const type = withTimeZone ? "timestamp with time zone" : "timestamp"
	if (!withTimeZone)
		return `z.iso.datetime({ local: true }).regex(/[^Zz]$/u, { message: "Must be a local date-time, with no offset or Z, which timestamp would discard" })${fractionRule(type, precision, "")}`
	return `z.iso.datetime({ offset: true }).regex(/${OFFSET}$/u, { message: "Must have an offset of at most 15:59, as Postgres holds one" })${fractionRule(type, precision, "(?:Z|[+-][\\d:]+)")}`
}

/** A time, local or with its offset, its fraction held to its precision (CD5, CD6 of r22b) */
function timeRule({ precision, withTimeZone }: { precision: number | null; withTimeZone: boolean }): string {
	return withTimeZone ? timetz(precision) : `z.iso.time()${fractionRule("time", precision, "")}`
}

/* an ISO 8601 duration as z.iso.duration takes one, with no lookaround, so RE2 compiles it (CS3 of
 * r22b): weeks alone, or at least one date or time part, the seconds alone taking a fraction */
const SECONDS = "\\d+(?:[.,]\\d+)?S"
const TIME_PART = `T(?:\\d+H(?:\\d+M)?(?:${SECONDS})?|\\d+M(?:${SECONDS})?|${SECONDS})`
const DURATION = `^P(?:\\d+W|(?:\\d+Y(?:\\d+M)?(?:\\d+D)?|\\d+M(?:\\d+D)?|\\d+D)(?:${TIME_PART})?|${TIME_PART})$`

// lookup-table: the ISO 8601 duration an interval's last field keeps, as a regex of no lookaround
const KEPT_BY: Readonly<Record<Exclude<IntervalField, "second">, string>> = {
	day: "^P[^T]*$",
	hour: "^P[^T]*(?:T\\d+H)?$",
	minute: "^P[^T]*(?:T(?:\\d+H)?(?:\\d+M)?)?$",
	month: "^P(?:\\d+Y)?(?:\\d+M)?$",
	year: "^P\\d+Y$",
}

/**
 * An interval: an ISO 8601 duration with no part below its last field, which Postgres drops
 * (`PT1H` into an `interval day` is stored as 0), and no fraction of a second past its precision,
 * which it rounds (CD6 of r22b)
 */
function intervalRule({ field, precision }: { field: IntervalField | null; precision: number | null }): string {
	const fields =
		field === null || field === "second"
			? ""
			: `.regex(/${KEPT_BY[field]}/u, { message: "Must hold no part below its ${field}s, which an interval of ${field}s drops" })`
	const fraction =
		precision === null
			? ""
			: `.regex(/^[^.]*${precision === 0 ? "" : `(?:\\.\\d{1,${precision}}S)?`}$/u, { message: "${roundedBy("interval", precision)}" })`
	return `z.iso.duration({ pattern: /${DURATION}/u })${fields}${fraction}`
}

/**
 * A numeric as text: its digits, within its precision and scale (CD5 of r22b). Postgres rounds a
 * longer fraction first, which may carry it past the precision (999.995 into numeric(5,2) is a
 * 22003), so the DTO takes none. A scale past the precision leaves a fraction alone, its first
 * scale - precision digits zeros; a scale below 0 a whole number whose last -scale digits are zeros
 */
function numericText(sqlType: string): string {
	const { precision, scale } = modifierAs(sqlType, "numeric")
	if (precision === null) return "z.string().regex(/^-?\\d+(?:\\.\\d+)?$/u)"
	if (scale < 0)
		return `z.string().regex(/^-?0*(?:\\d{1,${precision}}0{${-scale}}|0)$/u, { message: "Must be a whole number of at most ${precision} digits then ${-scale} zeros, which numeric(${precision}, ${scale}) holds unrounded" })`
	if (scale > precision)
		return `z.string().regex(/^-?0+(?:\\.(?:0{1,${scale}}|0{${scale - precision}}\\d{1,${precision}}))?$/u, { message: "Must be a number below 10^${precision - scale} of at most ${scale} digits after the point" })`
	const whole = precision - scale === 0 ? "0" : `\\d{1,${precision - scale}}`
	const fraction = scale === 0 ? "" : `(?:\\.\\d{1,${scale}})?`
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
		digit === "0" ? [] : [`${limit.slice(0, at)}[0-${Number(digit) - 1}]\\d{${limit.length - at - 1}}`],
	)
	return [...below, limit].join("|")
}

/* a bigint in drizzle's string mode: decimal digits within int8's range, as one pattern a JSON
   Schema reader applies too (CS8 of r22b): at most 18 significant digits, or 19 not past the bound */
const int64Text = (): string =>
	`z.string().regex(/^(?:0*(?:\\d{1,18}|${notAbove("9223372036854775807")})|-0*(?:\\d{1,18}|${notAbove("9223372036854775808")}))$/u, { message: "Must be a whole number within bigint's range, -2^63 to 2^63 - 1" })`

/*
 * float4 holds magnitudes up to 3.4028235e38, and refuses a value that rounds to zero: at or below
 * half its smallest subnormal, 2^-150 (1e-45 rounds up to 1.4e-45 and is taken; 1e-50 is not)
 */
const REAL =
	'z.number().min(-3.4028235e38).max(3.4028235e38).refine((val) => val === 0 || globalThis.Math.abs(val) > 7.006492321624085e-46, { message: "Must be zero or above 2^-150 in magnitude, which real would round to zero" }).meta({ not: { minimum: -7.006492321624085e-46, maximum: 7.006492321624085e-46, not: { const: 0 } } })'

/** The shared schema a cidr's rule is, which the entity file imports */
export const CIDR = "cidrSchema"

/* an inet holds a host address, its netmask optional; a cidr is the shared cidrSchema, which also
   refuses a bit set past its prefix length, through comb's own isCidr */
const INET = "z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()])"

/*
 * The spellings Postgres takes for a MAC address: octets of one or two hex digits each, all split
 * by `:` or all by `-`; two halves of six digits; groups of four split by `.` or `-`; or the digits
 * bare. A macaddr8 takes eight octets, or six, which it widens with ff:fe. Its case is written into
 * the classes and each separator is its own branch, as JSON Schema publishes no flag and RE2 takes no
 * backreference (CS2 of r22b)
 */
const HEX = "[\\dA-Fa-f]"
const OCTET = `${HEX}{1,2}`
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
	macRegex("Must be a MAC address of six or eight octets", [
		...[":", "-"].map((separator) => `${OCTET}(?:${separator}${OCTET}){5}(?:(?:${separator}${OCTET}){2})?`),
		`${HEX}{6}[:-](?:${HEX}{6}|${HEX}{10})`,
		`${HEX}{8}[:-]${HEX}{8}`,
		...splitBy(["\\.", "-"], QUAD, "{2,3}"),
		`${HEX}{12}|${HEX}{16}`,
	])

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
	"string date": () => "z.iso.date()",
	"string inet": () => INET,
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
