/**
 * The rule a write DTO gives a plain Postgres column by its data type (F50): what Postgres takes
 * for that type, as a zod check can say it, so a value the database would refuse is a 400 here
 * rather than a 22P02 from the insert. A rule is stricter than Postgres only for a spelling the
 * 0.14 changelog lists. A read DTO keeps the plain type, as a read never refuses a stored row (F65).
 */
import type { FieldMeta } from "../../analyzer-types.ts"

/* a time with an offset, which z.iso.time does not take: hh:mm[:ss[.f]], then Z, ±hh or ±hh[:]mm */
const TIMETZ =
	"z.string().regex(/^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|[+-](?:[01]\\d|2[0-3])(?::?[0-5]\\d)?)$/)"

/*
 * A timestamp keeps no zone: given an offset or Z it discards it, so the instant is lost. A
 * timestamptz given a local time reads it in the session's TimeZone, so the instant depends on
 * the server's config. Each takes only the form whose instant it keeps.
 */
const TIMESTAMP =
	'z.iso.datetime({ local: true }).regex(/[^Zz]$/, { message: "Must be a local date-time, with no offset or Z, which timestamp would discard" })'
const TIMESTAMPTZ = "z.iso.datetime({ offset: true })"

/** A numeric's declared precision and scale, from drizzle's `numeric(p, s)`; null when it declares none */
function precisionOf(sqlType: string): { precision: number; scale: number } | null {
	const declared = /^numeric\((\d+)(?:, ?(\d+))?\)/.exec(sqlType)
	return declared === null ? null : { precision: Number(declared[1]), scale: Number(declared[2] ?? 0) }
}

/**
 * A numeric as text: its digits, with no more before the point than precision less scale and no
 * more after it than scale. Postgres rounds a longer fraction first, which may carry it past the
 * precision (999.995 into numeric(5,2) is a 22003), so the DTO takes none
 */
function numericText(sqlType: string): string {
	const declared = precisionOf(sqlType)
	if (declared === null) return "z.string().regex(/^-?\\d+(?:\\.\\d+)?$/)"
	const { precision, scale } = declared
	const whole = precision - scale === 0 ? "0" : `\\d{1,${precision - scale}}`
	const fraction = scale === 0 ? "" : `(?:\\.\\d{1,${scale}})?`
	return `z.string().regex(/^-?0*${whole}${fraction}$/, { message: "Must be a number of at most ${precision - scale} digits before the point and ${scale} after it" })`
}

/**
 * A numeric read in drizzle's number mode: below 10^(precision - scale) in magnitude by at least
 * half its last place, so Postgres's rounding keeps it within the precision
 */
function numericNumber(sqlType: string): string | undefined {
	const declared = precisionOf(sqlType)
	if (declared === null) return undefined
	const bound = 10 ** (declared.precision - declared.scale) - 5 * 10 ** -(declared.scale + 1)
	return `z.number().gt(${-bound}).lt(${bound})`
}

/* a bigint in drizzle's string mode: decimal digits within int8's range, read as a BigInt once
   they are digits, as zod runs a refine after a failed regex too */
const INT64_TEXT =
	'z.string().regex(/^-?\\d+$/).refine((val) => !/^-?\\d+$/.test(val) || (BigInt(val) >= BigInt("-9223372036854775808") && BigInt(val) <= BigInt("9223372036854775807")), { message: "Must be within bigint\'s range, -2^63 to 2^63 - 1" })'

/*
 * float4 holds magnitudes up to 3.4028235e38, and refuses a value that rounds to zero: at or below
 * half its smallest subnormal, 2^-150 (1e-45 rounds up to 1.4e-45 and is taken; 1e-50 is not)
 */
const REAL =
	'z.number().min(-3.4028235e38).max(3.4028235e38).refine((val) => val === 0 || Math.abs(val) > 7.006492321624085e-46, { message: "Must be zero or above 2^-150 in magnitude, which real would round to zero" })'

/* an inet holds a host address, its netmask optional; a cidr is the shared cidrSchema, which also
   refuses a bit set past its prefix length, through comb's own isCidr */
const INET = "z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()])"

/* each data type drizzle gives a Postgres column, and its rule */
// lookup-table: a data type's write rule
const RULES: Readonly<Record<string, (field: FieldMeta) => string | undefined>> = {
	number: ({ sqlType }) => numericNumber(sqlType),
	"number float": () => REAL,
	"string cidr": () => "cidrSchema",
	"string date": () => "z.iso.date()",
	"string inet": () => INET,
	"string int64": () => INT64_TEXT,
	"string numeric": ({ sqlType }) => numericText(sqlType),
	"string time": ({ sqlType }) => (sqlType.startsWith("time with time zone") ? TIMETZ : "z.iso.time()"),
	"string timestamp": ({ sqlType }) => (sqlType.includes("with time zone") ? TIMESTAMPTZ : TIMESTAMP),
}

/** The write rule of a plain Postgres column of `field`'s data type; undefined when the plain type is its rule */
export function pgWriteRule(field: FieldMeta): string | undefined {
	return Object.hasOwn(RULES, field.dataType)
		? (RULES[field.dataType] as (field: FieldMeta) => string | undefined)(field)
		: undefined
}
