/**
 * CS1, CS2, CS3 of r22b: a JSON Schema reader compiles `pattern` under `u` (ECMA-262's unicode
 * mode, as Ajv does), and Go's and Rust's validators compile it with RE2 or its subset, which has
 * no lookaround and no backreference (README, "Go's and Rust's validators compile every comb
 * document"). So every pattern comb publishes, its own or a declared one, compiles under both, and
 * the field's zod schema takes exactly what a reader built from the published document takes.
 */
import { Ajv2020 } from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { RE2JS } from "re2js"
import { afterAll, describe, expect, it } from "vitest"
import * as z from "zod"
import { cleanGeneratedDtos, generatedDtos } from "../integration/support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

/* the create DTO's fields that publish a pattern, a precision's fraction rule among them (A2-10 of r22) */
const PATTERNED = [
	"parentId",
	"letters",
	"mail",
	"mac",
	"mac8",
	"span",
	"days",
	"clock",
	"money",
	"big",
	"wall3",
	"local3",
	"at0",
	"span3",
]

/* the declared patterns: a code point but a line break, a class, a property escape with and without u
   (a declared . is refused, A2-7 of r22) */
const DECLARED = `
	line: c.text("line", { pattern: "/^[^\\\\n\\\\r]{2}$/" }),
	other: c.text("other", { pattern: "/^[^x]$/" }),
	letters: c.text("letters", { pattern: "/^\\\\p{L}+$/" }),
	lettersU: c.text("letters_u", { pattern: "/^\\\\p{L}+$/u" }),
	lower: c.text("lower", { lowercase: true, pattern: "/^[a-z]+$/" }),
	label: c.text("label", { name: true }),
	image: c.text("image", { imageUri: true }),
	mail: c.text("mail", { email: true }),
	site: c.text("site", { url: true }),`

const PG = `import { bigint, bit, cidr, date, inet, interval, macaddr, macaddr8, numeric, time, timestamp, uuid } from "drizzle-orm/pg-core"
export const parent = pgTable("parent", { id: c.id("par") })
export const row = pgTable("row", {
	id: c.id("row"),
	parentId: c.ref("parent_id").references(() => parent.id),${DECLARED}
	mac: macaddr("mac"),
	mac8: macaddr8("mac8"),
	span: interval("span"),
	days: interval("days", { fields: "day" }),
	minutes: interval("minutes", { fields: "hour to minute" }),
	whole: interval("whole", { precision: 0 }),
	clock: time("clock", { withTimezone: true }),
	wall: time("wall"),
	at: timestamp("at", { mode: "string", withTimezone: true }),
	local: timestamp("local", { mode: "string" }),
	money: numeric("money", { precision: 5, scale: 2 }),
	big: bigint("big", { mode: "string" }),
	bits: bit("bits", { dimensions: 4 }),
	key: uuid("key"),
	day: date("day"),
	ip: inet("ip"),
	net: cidr("net"),
	/* A2-10 of r22: each fraction rule a precision writes, so the lanes read its digit class */
	wall3: time("wall3", { precision: 3 }),
	local3: timestamp("local3", { mode: "string", precision: 3 }),
	at0: timestamp("at0", { mode: "string", withTimezone: true, precision: 0 }),
	span3: interval("span3", { precision: 3 }),
})`

const SQLITE = `export const parent = sqliteTable("parent", { id: c.id("par") })
export const row = sqliteTable("row", {
	id: c.id("row"),
	parentId: c.ref("parent_id").references(() => parent.id),${DECLARED}
})`

type Lane = { dialect: "postgres" | "sqlite"; name: string; schema: z.ZodObject }

/** The create and update DTOs codegen writes for the fixture tables, on both dialects */
async function lanes(): Promise<Lane[]> {
	const found: Lane[] = []
	for (const [dialect, tables] of [
		["postgres", PG],
		["sqlite", SQLITE],
	] as const) {
		const dtos = (await generatedDtos(`published-patterns-${dialect}`, tables, { dialect }))["row"] ?? {}
		for (const name of ["rowDtoCreateSchema", "rowDtoUpdateSchema"])
			found.push({ dialect, name, schema: dtos[name] as z.ZodObject })
	}
	return found
}

type Node = Record<string, unknown>
const published = (schema: z.ZodType): Node => z.toJSONSchema(schema, { io: "input" }) as Node

/** Every `pattern` anywhere in `node` */
function patternsOf(node: unknown, found: string[] = []): string[] {
	if (Array.isArray(node)) for (const child of node) patternsOf(child, found)
	else if (node !== null && typeof node === "object")
		for (const [key, child] of Object.entries(node)) {
			if (key === "pattern" && typeof child === "string") found.push(child)
			else patternsOf(child, found)
		}
	return found
}

/** Why `pattern` does not compile under `engine`, or null when it does */
function refusal(engine: (pattern: string) => unknown, pattern: string): string | null {
	try {
		engine(pattern)
		return null
	} catch (error) {
		return (error as Error).message
	}
}

const ENGINES: Array<[name: string, engine: (pattern: string) => unknown]> = [
	["ECMA-262 under u", (pattern) => new RegExp(pattern, "u")],
	["RE2", (pattern) => RE2JS.compile(pattern)],
]

/* strings where the two regex modes part: astral, combining, escaped and cased; then the values the
 * built-in patterns bound (a MAC, a duration, an id, an offset); none a reader's text check refuses */
const POOL = [
	"",
	"a",
	"ab",
	/* A2-7 of r22: the line terminators ECMAScript's . refuses and RE2's takes, beside one character */
	"a\r",
	"a\u2028",
	"a\u2029",
	"abc",
	"ABC",
	"x",
	"a-b",
	"a\\-b",
	"p{L}",
	"pL",
	"é",
	"e\u0301",
	"e\u0301e\u0301",
	"ß",
	"İ",
	"😀",
	"😀😀",
	"ab😀",
	"𝒜",
	"𝒜𝒜",
	"Jo O'Neil",
	"a b",
	"a\nb",
	"\u{10FFFF}",
	"08:00:2b:01:02:03",
	"08:00:2B:01:02:03",
	"08-00-2B-01-02-03",
	"08:00-2b:01:02:03",
	"08002B010203",
	"0800.2b01.0203",
	"0800-2b01-0203",
	"08002b:010203",
	"08002b-010203",
	"08:00:2b:01:02:03:04:05",
	"08002B0102030405",
	"08-00-2b-01-02-03-04-05",
	"0800.2b01.0203.0405",
	"08002b:0102030405",
	"8:0:2b:1:2:3",
	"P1D",
	"PT1H",
	"P1Y2M3DT4H5M6.5S",
	"P",
	"PT",
	"P1W",
	"-P1D",
	"P1DT",
	"PT1.5S",
	"PT1.4S",
	"PT1M",
	"P1DT1H",
	"1 day",
	"P1.5D",
	"PT0.123456S",
	"PT0.1234567S",
	"P1M",
	"P2Y",
	"PT1H1M",
	"P1DT1S",
	"a".repeat(48),
	"a".repeat(49),
	"😀".repeat(24),
	"😀".repeat(25),
	"row_01h5a3g8k9m2n4p6q8r0t2v4x6",
	"user@example.com",
	"a@b.cc",
	"bad@",
	"ü@example.com",
	"a😀@example.com",
	/* A2-8 of r22: a hyphen ending a label, which zod's email takes and the email format refuses */
	"a@b-.cc",
	"10:00:00+02:00",
	"10:00:00.123456+02:00",
	/* A2-10: fractions at and past a precision of 3 and of 0, and a non-ASCII digit in one */
	"10:00:00.123",
	"10:00:00.1234",
	"10:00:00.12\u0663",
	"2024-01-01T10:00:00.123",
	"2024-01-01T10:00:00.1234",
	"2024-01-01T10:00:00Z",
	"2024-01-01T10:00:00.5Z",
	"PT1.123S",
	"PT1.1234S",
	"10:00:00",
	"2024-01-01T10:00:00+02:00",
	"2024-01-01T10:00:00",
	"2024-01-01",
	"123e4567-e89b-12d3-a456-426614174000",
	"10.0.0.1",
	"10.0.0.0/8",
	"::1",
	/* AA12 of r22: an IPv4 tail, which zod's ipv6 and cidrv6 check took and their pattern refused */
	"::ffff:1.2.3.4",
	"64:ff9b::1.2.3.4",
	"::ffff:1.2.3",
	"::ffff:1.2.3.0/120",
	"::ffff:01.2.3.4",
	"::/1.5",
	"fe80::1%eth0",
	"1010",
	"12.5",
	"-3",
	"data:image/png;base64,AA",
	"https://example.com/a.png",
	/* A2-8 of r22: a space in a path, which the WHATWG parser escapes and the uri format refuses */
	"https://a/b c",
	/* AA7 of r22: where ECMAScript's \s, RE2's and Rust's part, and where \d and \w do */
	"a\u00a0b",
	"row_\u00a0x",
	" ab ",
	"a\vb",
	"\v",
	"ab\ufeff",
	"a\u2028b",
	"\u3000",
	"\u1680x",
	"a\u202fb",
	"\u0663\u0662\u0661",
	"\uff11\uff12\uff13",
	"PT\u0661S",
	"\u0661\u0662.5",
]

const TRANSFORMS: Record<string, (text: string) => string> = {
	lowercase: (text) => text.toLowerCase(),
	trim: (text) => text.trim(),
	uppercase: (text) => text.toUpperCase(),
}

/**
 * Ajv's regex engine as RE2, which Go's validators run: re2js, searching as `pattern` does. Ajv
 * caches a compiled pattern by its string, so each says its own source (AA7 of r22)
 */
const re2Engine = Object.assign(
	(source: string) => {
		const compiled = RE2JS.compile(source)
		return { test: (text: string) => compiled.matcher(text).find(), toString: () => `/${source}/` }
	},
	{ code: "re2" },
)

/** Every `x-` annotation key in `node`, which a strict reader compiles only once it is declared */
const annotationsOf = (node: unknown): string[] =>
	node === null || typeof node !== "object"
		? []
		: Object.entries(node).flatMap(([key, value]) => [...(key.startsWith("x-") ? [key] : []), ...annotationsOf(value)])

/*
 * AA10, A2-2 of r22: a reader checks `format` too, with every format ajv-formats 3 defines, in
 * Ajv's default strict mode, which refuses a format it does not know; comb's `x-` keys are
 * annotations it declares. What it takes: the field's transforms applied, then the schema
 */
function readerOf(field: Node, defs: unknown, re2 = false): (value: string) => boolean {
	const ajv = addFormats(
		new Ajv2020({ logger: false, validateFormats: true, ...(re2 ? { code: { regExp: re2Engine } } : {}) }),
	)
	for (const key of new Set(annotationsOf({ defs, field }))) ajv.addKeyword(key)
	const validate = ajv.compile({ ...field, $defs: defs ?? {} })
	const transforms = (field["x-comb-transform"] as string[] | undefined) ?? []
	return (value) =>
		validate(transforms.reduce((text, name) => (TRANSFORMS[name] as (t: string) => string)(text), value))
}

describe("the patterns comb publishes (CS1, CS2, CS3; siblings: the id, the MAC, the interval and the email patterns)", () => {
	it("each compile under u and under RE2, with no lookaround and no backreference", async () => {
		const refused: string[] = []
		for (const { dialect, name, schema } of await lanes())
			for (const pattern of new Set(patternsOf(published(schema))))
				for (const [engine, compile] of ENGINES) {
					const why = refusal(compile, pattern)
					if (why !== null) refused.push(`${dialect} ${name} ${engine}: ${pattern}: ${why.slice(0, 120)}`)
				}
		expect(refused).toEqual([])
	})

	it.each([
		["an ECMA-262 reader's", false],
		["an RE2 reader's, as Go's is (AA7 of r22)", true],
	])(
		"hold zod's verdict equal to %s, field by field, over astral, combining, escape and blank cases",
		async (_, re2) => {
			const disagree: string[] = []
			for (const { dialect, name, schema } of await lanes()) {
				const document = published(schema)
				for (const [key, field] of Object.entries(document["properties"] as Record<string, Node>)) {
					if (patternsOf(field).length === 0) continue
					const reader = readerOf(field, document["$defs"], re2)
					const parse = schema.shape[key] as z.ZodType
					for (const value of POOL)
						if (parse.safeParse(value).success !== reader(value))
							disagree.push(`${dialect} ${name}.${key} ${JSON.stringify(value)}: zod ${parse.safeParse(value).success}`)
				}
			}
			expect(disagree).toEqual([])
		},
	)

	/* Rust's regex reads \d and \w as Unicode, and RE2 reads \s as ASCII: a pattern that holds none
	   of the shorthand classes means one set in every engine, which holds the Rust lane without a
	   Rust toolchain (AA7 of r22) */
	it("hold no \\d, \\w, \\s or \\b, nor their capitals, each class written out", async () => {
		const shorthand = /(?<!\\)(?:\\\\)*\\[bBdDsSwW]/u
		const held: string[] = []
		for (const { dialect, name, schema } of await lanes())
			for (const pattern of new Set(patternsOf(published(schema))))
				if (shorthand.test(pattern)) held.push(`${dialect} ${name}: ${pattern}`)
		expect(held).toEqual([])
	})

	it("covers every built-in pattern's field on postgres", async () => {
		const [create] = await lanes()
		const fields = Object.entries(published((create as Lane).schema)["properties"] as Record<string, Node>)
		const patterned = fields.filter(([, field]) => patternsOf(field).length > 0).map(([key]) => key)
		expect(patterned).toEqual(expect.arrayContaining(PATTERNED))
	})
})
