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

/* each data type drizzle gives a Postgres column, and its rule */
// lookup-table: a data type's write rule
const RULES: Readonly<Record<string, (field: FieldMeta) => string>> = {
	"string date": () => "z.iso.date()",
	"string time": ({ sqlType }) => (sqlType.startsWith("time with time zone") ? TIMETZ : "z.iso.time()"),
	"string timestamp": ({ sqlType }) => (sqlType.includes("with time zone") ? TIMESTAMPTZ : TIMESTAMP),
}

/** The write rule of a plain Postgres column of `field`'s data type; undefined when the plain type is its rule */
export function pgWriteRule(field: FieldMeta): string | undefined {
	return Object.hasOwn(RULES, field.dataType)
		? (RULES[field.dataType] as (field: FieldMeta) => string)(field)
		: undefined
}
