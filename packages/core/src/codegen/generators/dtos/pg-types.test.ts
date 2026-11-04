import { describe, expect, it } from "vitest"
import * as z from "zod"
import { parseField } from "../../__fixtures__/runtime.ts"
import type { ImportsMeta } from "../../analyzer-types.ts"
import type { SchemaType } from "./dto-types.ts"
import { generateFieldSchema } from "./field-schema.ts"
import { pgModifierOf, pgWriteRule } from "./pg-types.ts"

const imports = (): ImportsMeta => ({ enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() })

/** The schema a Postgres column written as `source` gets in a `type` DTO */
const pgSchema = (source: string, type: SchemaType) =>
	generateFieldSchema(parseField("v", source, { dialect: "postgres" }), type, {
		dialect: "postgres",
		imports: imports(),
	})

/** The write rule of a Postgres column written as `source` */
const rule = (source: string) => pgWriteRule(parseField("v", source, { dialect: "postgres" }))

describe("pgWriteRule: a plain Postgres column's write rule by its data type (F50)", () => {
	it("gives the date and time types their ISO rule, a time with a zone its offset", () => {
		/* each format with comb's own pattern, its digits [0-9], as Rust's regex reads zod's \\d as any digit (AA7 of r22) */
		expect(rule('date("v")')).toMatch(/^z\.stringFormat\("date", \/\^\(\?:\(\?:\[0-9\]\[0-9\]\[2468\].*\$\/u\)$/)
		/* each keeps the instant: a timestamp only a local time, a timestamptz only one with its offset */
		expect(rule('timestamp("v", { mode: "string" })')).toMatch(
			/^z\.stringFormat\("datetime", \/\^.*\$\/u\)\.regex\(\/\[\^Zz\]/,
		)
		expect(rule('timestamp("v", { mode: "string", withTimezone: true, precision: 3 })')).toMatch(
			/^z\.stringFormat\("datetime", \/\^.*Z\|\(\[\+-\].*\$\/u\)\.regex\(/,
		)
		expect(rule('time("v")')).toBe(
			String.raw`z.stringFormat("time", /^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.[0-9]+)?)?$/u)`,
		)
		expect(rule('time("v", { withTimezone: true })')).toMatch(/^z\.string\(\)\.regex\(.*\(\?:Z\|\[\+-\]/)
		expect(rule('text("v")')).toBeUndefined()
	})

	/* the shapes the Postgres suite leaves out, evaluated as the generated DTO evaluates them */
	it("bounds a numeric by its own precision and scale, a fraction-only one at 0 before the point", () => {
		const check = (source: string) => new Function("z", `return ${rule(source)}`)(z) as z.ZodType
		const fractionOnly = check('numeric("v", { precision: 2, scale: 2 })')
		expect(["0.99", "-0.5", "0", ".5", "1.0", "0.123"].map((v) => fractionOnly.safeParse(v).success)).toEqual([
			true,
			true,
			true,
			false,
			false,
			false,
		])
		expect(rule('numeric("v", { mode: "number" })')).toBeUndefined()
		expect(check('numeric("v", { mode: "number", precision: 3 })').safeParse(999.4).success).toBe(true)
		expect(check('numeric("v", { mode: "number", precision: 3 })').safeParse(999.5).success).toBe(false)
	})

	/* F50: a Postgres data type with no rule is refused, never typed as plain text, naming what comb types */
	it("refuses a Postgres type comb has no rule for, listing the ones it types", () => {
		expect(() => rule('sparsevec("v", { dimensions: 3 })')).toThrow(
			/fixture\.v: comb has no rule for a PgSparseVector column \(string sparsevec\); build it with a c helper, or as drizzle text, varchar, char, uuid, .*inet, cidr, macaddr, macaddr8, bit/,
		)
		expect(rule('bit("v", { dimensions: 3 })')).toBe(
			'z.string().regex(/^[01]{3}$/u, { message: "Must be exactly 3 bits" })',
		)
	})

	it("is the create and update DTOs' rule, and a read keeps the plain type", () => {
		expect(pgSchema('date("v").notNull()', "create")).toBe(rule('date("v")'))
		expect(pgSchema('date("v")', "update")).toBe(`${rule('date("v")')}.nullable().optional()`)
		for (const type of ["read", "readPartial"] as const)
			expect(pgSchema('date("v").notNull()', type)).not.toContain("z.iso")
	})

	it("leaves a SQLite column and a c helper's column to their own rules", () => {
		const sqlite = parseField("v", 'text("v")')
		expect(generateFieldSchema({ ...sqlite, dataType: "string date" }, "create", { imports: imports() })).not.toContain(
			"z.iso",
		)
		expect(pgSchema('c.text("v")', "create")).not.toContain("z.iso")
	})
})

type Schema = { anyOf?: Schema[]; items?: Schema } & Record<string, unknown>

/** Each level's `items` of a read array `source`, down to the element alone: Postgres holds 6 */
function levels(source: string): Schema[] {
	const code = pgSchema(source, "read") as string
	const property = z.toJSONSchema(new Function("z", `return ${code}`)(z) as z.ZodType, { io: "output" }) as Schema
	const array = (schema: Schema | undefined): Schema | undefined =>
		schema?.type === "array" ? schema : schema?.anyOf?.find((member) => member.type === "array")
	const found: Schema[] = []
	for (let at = array(property); at?.items !== undefined; at = array(at.items)) found.push(at.items)
	return found
}

const xComb = (schema: Schema) =>
	Object.fromEntries(Object.entries(schema).filter(([key]) => key.startsWith("x-comb-")))

/* C3 of r20: §2.1 puts an array element's keys on `items` beside its anyOf, at every depth a reader stops at */
describe("a Postgres read array's stated bounds", () => {
	it.each([
		['c.text("v", { max: 5 }).array()', { "x-comb-maxLength": 5 }],
		['c.text("v", { max: 5 }).array().notNull()', { "x-comb-maxLength": 5 }],
		['c.integer("v", { min: 1, max: 9 }).array()', { "x-comb-maximum": 9, "x-comb-minimum": 1 }],
		['c.real("v", { min: 0, max: 1 }).array().notNull()', { "x-comb-maximum": 1, "x-comb-minimum": 0 }],
	])("sit on items at every depth: %s", (source, keys) => {
		const found = levels(source)
		expect(found).toHaveLength(6)
		expect(found.map(xComb)).toEqual(found.map(() => keys))
	})
})

/** Whether the rule of a Postgres column written as `source` takes each of `values` */
const takes = (source: string, values: string[]) => {
	const schema = new Function("z", `return ${rule(source)}`)(z) as z.ZodType
	return values.map((value) => schema.safeParse(value).success)
}

/* CD5, CD6 of r22b: the PG17 suite (pg-typmods) holds each rule to Postgres; these hold the parse and each branch */
describe("a Postgres type modifier is parsed once (CD5, CD6; sibling: numeric's scale bound)", () => {
	it.each([
		["time", { base: "time", precision: null, withTimeZone: false }],
		["time(3) with time zone", { base: "time", precision: 3, withTimeZone: true }],
		["timestamp (0)", { base: "timestamp", precision: 0, withTimeZone: false }],
		["timestamp(6) with time zone", { base: "timestamp", precision: 6, withTimeZone: true }],
		["numeric", { base: "numeric", precision: null, scale: 0 }],
		["numeric(3)", { base: "numeric", precision: 3, scale: 0 }],
		["numeric(2, 5)", { base: "numeric", precision: 2, scale: 5 }],
		["numeric(3, -2)", { base: "numeric", precision: 3, scale: -2 }],
		["interval", { base: "interval", field: null, precision: null }],
		["interval(3)", { base: "interval", field: null, precision: 3 }],
		["interval day", { base: "interval", field: "day", precision: null }],
		["interval year to month", { base: "interval", field: "month", precision: null }],
		["interval day to second(3)", { base: "interval", field: "second", precision: 3 }],
		["bit(3)", { base: "bit", length: 3 }],
		["text", { base: "other" }],
	] as const)("reads %s", (sqlType, modifier) => {
		expect(pgModifierOf(sqlType)).toEqual(modifier)
	})
})

describe("a time's rules read the parsed modifier (CD5, CD6; sibling: a timestamp's precision)", () => {
	it("holds a time's fraction to its precision, local or with an offset", () => {
		expect(takes('time("v", { precision: 0 })', ["10:00", "10:00:01", "10:00:01.5"])).toEqual([true, true, false])
		expect(takes('time("v", { precision: 2 })', ["10:00:01.25", "10:00:01.255"])).toEqual([true, false])
		expect(takes('time("v")', ["10:00:01.123456789"])).toEqual([true])
		expect(takes('time("v", { precision: 0, withTimezone: true })', ["10:00:01Z", "10:00:01.5Z"])).toEqual([
			true,
			false,
		])
		expect(
			takes('time("v", { precision: 2, withTimezone: true })', ["10:00:01.25+02:00", "10:00:01.255+02:00"]),
		).toEqual([true, false])
		expect(takes('time("v", { withTimezone: true })', ["10:00:01.123456+02:00", "10:00:01"])).toEqual([true, false])
	})

	it("holds a timestamp's fraction to its precision, local or with an offset", () => {
		expect(
			takes('timestamp("v", { mode: "string", precision: 0 })', ["2024-01-01T10:00:00", "2024-01-01T10:00:00.5"]),
		).toEqual([true, false])
		expect(
			takes('timestamp("v", { mode: "string", precision: 2, withTimezone: true })', [
				"2024-01-01T10:00:00.12+02:00",
				"2024-01-01T10:00:00.123Z",
			]),
		).toEqual([true, false])
		expect(
			takes('timestamp("v", { mode: "string", precision: 0, withTimezone: true })', ["2024-01-01T10:00:00.1Z"]),
		).toEqual([false])
	})
})

/* drizzle writes an interval's precision 0 as no precision, so the rule never reads 0: a drizzle
   that kept it fails here before a {1,0} reached a published pattern */
describe("an interval's precision 0, as drizzle writes it (sibling: the interval's fraction rule)", () => {
	it.each(['interval("v", { precision: 0 })', 'interval("v", { fields: "second", precision: 0 })'])(
		"reads no precision from %s, and holds no fraction rule",
		(column) => {
			const field = parseField("v", column, { dialect: "postgres" })
			expect(pgModifierOf(field.sqlType)).toMatchObject({ base: "interval", precision: null })
			expect(pgWriteRule(field)).not.toContain("[^.]")
		},
	)
})

describe("an interval's and a numeric's rules read the parsed modifier (CD5, CD6; sibling: numeric's scale bound)", () => {
	it("keeps an interval's parts at and above its last field, and its fraction to its precision", () => {
		expect(takes('interval("v", { fields: "year" })', ["P2Y", "P2Y1M"])).toEqual([true, false])
		expect(takes('interval("v", { fields: "minute" })', ["P1DT1H1M", "PT1M1S"])).toEqual([true, false])
		expect(takes('interval("v", { fields: "second" })', ["P1DT1.25S"])).toEqual([true])
		expect(takes('interval("v", { fields: "hour to second", precision: 2 })', ["PT1.25S", "PT1.255S"])).toEqual([
			true,
			false,
		])
		expect(takes('interval("v")', ["P1Y2M3DT4H5M6.789S"])).toEqual([true])
	})

	/* AA6 of r22: zod's duration takes a comma for the decimal mark, which Postgres refuses with a 22007 */
	it.each([
		'interval("v")',
		'interval("v", { precision: 3 })',
		'interval("v", { fields: "day to second", precision: 3 })',
	])("refuses a comma for the seconds' decimal mark in %s", (column) => {
		expect(takes(column, ["PT1,5S", "P1DT1,5S", "PT1M1,25S", "PT0,1S", "PT1.5S"])).toEqual([
			false,
			false,
			false,
			false,
			true,
		])
	})

	it("bounds a numeric by a scale past its precision, or below 0", () => {
		expect(
			takes('numeric("v", { precision: 1, scale: 3 })', ["0.009", "0.001", "0.01", "0.0091", "0.000", "-0.003"]),
		).toEqual([true, true, false, false, true, true])
		expect(takes('numeric("v", { precision: 2, scale: -3 })', ["99000", "1000", "100000", "1500", "0"])).toEqual([
			true,
			true,
			false,
			false,
			true,
		])
		const bound = new Function("z", `return ${rule('numeric("v", { mode: "number", precision: 3, scale: -2 })')}`)(
			z,
		) as z.ZodType
		expect([99_949, 99_950].map((value) => bound.safeParse(value).success)).toEqual([true, false])
	})

	it("refuses a data type whose SQL type holds no modifier of its kind", () => {
		const field = parseField("v", 'time("v")', { dialect: "postgres" })
		expect(() => pgWriteRule({ ...field, sqlType: "time zone" })).toThrow(
			new TypeError("comb reads no time modifier in time zone"),
		)
	})
})

/*
 * CD11 of r22b: a timetz and a timestamptz take one offset spelling, RFC 3339's `Z` or `±hh:mm`,
 * which JSON Schema's `time` and `date-time` formats name, its hours at most 15 as Postgres holds
 * one. 0.20's timetz took `+02` and `+0200` too, which the timestamptz's z.iso.datetime refused
 */
describe("a timetz and a timestamptz take one offset spelling (CD11 of r22b; siblings: Z, an hour past 15)", () => {
	const OFFSETS = ["Z", "+02:00", "-15:59", "+05:30", "+0200", "+02", "-0530", "+16:00", "z", "+02:60"]
	const TAKEN = [true, true, true, true, false, false, false, false, false, false]

	it("on each, RFC 3339's alone", () => {
		const timetz = takes(
			'time("v", { withTimezone: true })',
			OFFSETS.map((offset) => `10:00:00${offset}`),
		)
		const timestamptz = takes(
			'timestamp("v", { mode: "string", withTimezone: true })',
			OFFSETS.map((offset) => `2024-01-01T00:00:00${offset}`),
		)
		expect(timetz).toEqual(TAKEN)
		expect(timestamptz).toEqual(TAKEN)
	})
})

/*
 * AA7 of r22: comb publishes its own copy of zod's ISO date, date-time and time regexes, each \d
 * written as [0-9]. Read from zod as it runs, so a zod release that changes one fails here rather
 * than leaving comb's rule and zod's apart
 */
/** The pattern zod publishes for a format, its regex's source */
const zodPattern = (schema: z.ZodType): string => (z.toJSONSchema(schema) as { pattern: string }).pattern

/* the one departure, A2-3 of r22: no year 0000, a 22008 in Postgres, in the leap branch or the rest */
const YEAR_0001: readonly (readonly [string, string])[] = [
	["[02468][048]00", "(?:[2468][048]|0[48])00"],
	["[0-9]{4}-", "(?:000[1-9]|00[1-9][0-9]|0[1-9][0-9]{2}|[1-9][0-9]{3})-"],
]

describe("comb's ISO patterns are zod's, each \\d written as [0-9], its year 0001 at least (AA7, A2-3 of r22)", () => {
	it.each([
		['date("v")', z.iso.date()],
		['timestamp("v", { mode: "string" })', z.iso.datetime({ local: true })],
		['timestamp("v", { mode: "string", withTimezone: true })', z.iso.datetime({ offset: true })],
		['time("v")', z.iso.time()],
	] as const)("%s", (column, zod) => {
		const comb = /^z\.stringFormat\("[a-z]+", \/(.*?)\/u\)/.exec(rule(column) as string)?.[1]
		const departed = YEAR_0001.reduce(
			(pattern, [from, to]) => pattern.replace(from, to),
			zodPattern(zod).replaceAll(String.raw`\d`, "[0-9]"),
		)
		expect(comb).toBe(departed)
	})
})

/*
 * What a consumer sees of the move from z.iso.* to z.stringFormat (AA7 of r22): an issue of the same
 * code, format and message, with no origin and no pattern, as the Upgrading item says
 */
describe("an ISO rule's issue, as z.stringFormat raises it (AA7 of r22)", () => {
	it.each([
		['date("v")', z.iso.date(), "2024-02-30"],
		['timestamp("v", { mode: "string" })', z.iso.datetime({ local: true }), "2024-01-01 10:00"],
		['time("v")', z.iso.time(), "25:00"],
	] as const)("%s keeps zod's code, format and message, with no origin or pattern", (column, zod, bad) => {
		const comb = new Function("z", `return ${rule(column)}`)(z) as z.ZodType
		const [issue] = comb.safeParse(bad).error?.issues ?? []
		const [own] = zod.safeParse(bad).error?.issues ?? []
		expect(Object.keys(issue ?? {}).sort()).toEqual(["code", "format", "message", "path"])
		expect(Object.keys(own ?? {}).sort()).toEqual(["code", "format", "message", "origin", "path", "pattern"])
		expect(issue).toEqual({ ...own, origin: undefined, pattern: undefined })
	})
})
