/** createListQuerySchema's construction checks: extension names it reserves, and the page bound */
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createListQuerySchema } from "./list-schema.ts"
import { createRetrieveQuerySchema } from "./retrieve-schema.ts"
import { MAX_CURSOR_LENGTH } from "./cursor.ts"
import { LIST_QUERY_LIMITS, MAX_QUERY_BYTES, PAGINATION_DEFAULTS, REQUEST_BYTES } from "./schema-limits.ts"

const RESERVED = [
	"cursor",
	"filter",
	"filterAst",
	"lang",
	"limit",
	"limitBound",
	"order",
	"page",
	"pageBound",
	"parsedFields",
	"parsedSort",
	"q",
	"select",
	"sortOrderBy",
	"tiebreak",
	"validated",
]

describe("an extension named like a param or an output key (Q12)", () => {
	it.each(RESERVED)("refuses %s at construction, which would replace a checked value", (key) => {
		expect(() => createListQuerySchema({ extend: { [key]: z.any() } as never, sort: ["id"] })).toThrow(
			new TypeError(`createListQuerySchema: extend.${key} is reserved; name the extension otherwise`),
		)
	})

	it("refuses one at the type level too, and takes any other name", () => {
		// @ts-expect-error filterAst is reserved
		expect(() => createListQuerySchema({ extend: { filterAst: z.any() }, sort: ["id"] })).toThrow(TypeError)
		// @ts-expect-error limitBound is reserved
		expect(() => createListQuerySchema({ extend: { limitBound: z.any() }, sort: ["id"] })).toThrow(TypeError)
		// @ts-expect-error pageBound is reserved
		expect(() => createListQuerySchema({ extend: { pageBound: z.any() }, sort: ["id"] })).toThrow(TypeError)
		const schema = createListQuerySchema({ extend: { archived: z.enum(["yes"]).optional() }, sort: ["id"] })
		expect(schema.parse({ archived: "yes" }).archived).toBe("yes")
	})
})

/* the bounds come from the config alone: a client that names one is an unknown param (C7 of r19) */
describe("a request naming a bound", () => {
	it.each(["limitBound", "pageBound"])("refuses %s as it refuses any unknown param, and the schema's stands", (key) => {
		const schema = createListQuerySchema({ sort: ["id"] })
		const refused = schema.safeParse({ [key]: "1000000" })
		expect(refused.success).toBe(false)
		expect(refused.error?.issues).toEqual([expect.objectContaining({ code: "unrecognized_keys", keys: [key] })])
		const retrieve = createRetrieveQuerySchema({ fields: { scalars: ["id"] } })
		expect(retrieve.safeParse({ [key]: "1000000" }).success).toBe(false)
		expect(schema.parse({})).toMatchObject({ limitBound: 100, pageBound: 10_000 })
	})
})

describe("the page bound (Q13)", () => {
	/* L2 of the 0.12 consumers review: one contract for a deep page, the one the hand-built list answers */
	const tooDeep = expect.objectContaining({ errorKey: "page_too_deep", status: 400 })

	it("takes pages up to maxPage, 10 000 by default, and answers one past it page_too_deep", async () => {
		const schema = createListQuerySchema({ sort: ["id"] })
		expect(PAGINATION_DEFAULTS.maxPage).toBe(10_000)
		expect(schema.safeParse({ page: "10000" }).success).toBe(true)
		for (const page of ["10001", "999999999", String(Number.MAX_SAFE_INTEGER)]) {
			expect(() => schema.safeParse({ page })).toThrow(tooDeep)
			expect(() => schema.parse({ cursor: "c", page })).toThrow(tooDeep)
			await expect(schema["~standard"].validate({ page })).rejects.toThrow(tooDeep)
		}
		expect(z.toJSONSchema(schema, { io: "input" }).properties?.page).toMatchObject({ maximum: 10_000, minimum: 1 })
	})

	/* U36: one contract for a page that is no whole number from 1, the one buildListQuery and paginate answer */
	it("answers a page that is no whole number from 1, in decimal digits, invalid_page", async () => {
		const schema = createListQuerySchema({ sort: ["id"] })
		const invalid = expect.objectContaining({ errorKey: "invalid_page", status: 400 })
		for (const page of ["0", "-3", "1.5", "x", "", " 2", "0x10", "0b1", "0o7", "1e3", "Infinity", 0, 1.5, -1]) {
			expect(() => schema.safeParse({ page })).toThrow(invalid)
			await expect(schema["~standard"].validate({ page })).rejects.toThrow(invalid)
		}
		expect(schema.parse({ page: "16" }).page).toBe(16)
		expect(schema.parse({ page: 16 }).page).toBe(16)
		expect(z.toJSONSchema(schema, { io: "input" }).properties?.page).toMatchObject({ minimum: 1, type: "integer" })
	})

	it("takes a limit in decimal digits only, and refuses any other spelling as a field error", () => {
		const schema = createListQuerySchema({ sort: ["id"] })
		for (const limit of ["0x10", "0b1", "0o7", "1e1", " 16", "", "1.5"])
			expect(schema.safeParse({ limit }).success).toBe(false)
		expect(schema.parse({ limit: "16" }).limit).toBe(16)
		expect(schema.parse({ limit: 16 }).limit).toBe(16)
		expect(schema.parse({}).limit).toBe(PAGINATION_DEFAULTS.defaultLimit)
		expect(z.toJSONSchema(schema, { io: "input" }).properties?.limit).toMatchObject({
			maximum: PAGINATION_DEFAULTS.maxLimit,
			minimum: 1,
			type: "integer",
		})
	})

	it("takes a maxPage of its own, and refuses one whose last offset is past 2^53 - 1", () => {
		const schema = createListQuerySchema({ pagination: { maxPage: 50 }, sort: ["id"] })
		expect(schema.safeParse({ page: "50" }).success).toBe(true)
		expect(() => schema.safeParse({ page: "51" })).toThrow(tooDeep)
		expect(() => schema.parse({ page: 51 })).toThrow(tooDeep)
		expect(() =>
			createListQuerySchema({ pagination: { maxLimit: 2000, maxPage: Number.MAX_SAFE_INTEGER }, sort: ["id"] }),
		).toThrow(TypeError)
		expect(() => createListQuerySchema({ pagination: { maxPage: 0 }, sort: ["id"] })).toThrow(TypeError)
	})
})

/** A value of `prefix` and as many ~ as `bytes` takes, each ~ three bytes as a form writes it */
const at = (bytes: number, prefix = "") => `${prefix}${"~".repeat(Math.floor((bytes - prefix.length) / 3))}`

describe("request caps by percent-encoded bytes, which a URL limit counts (R10)", () => {
	const schema = createListQuerySchema({
		fields: { scalars: ["id", "title"] },
		filter: { title: "string" },
		search: ["title"],
		sort: ["id"],
	})
	const ok = (input: Record<string, string>) => schema.safeParse(input).success

	it("takes an ASCII filter of 2048 characters and refuses a CJK one of the same length", () => {
		expect(ok({ filter: `title.eq.${"a".repeat(2039)}` })).toBe(true)
		/* each CJK character percent-encodes to 9 bytes: 2048 of them are 18 KB */
		expect(ok({ filter: `title.eq.${"長".repeat(2039)}` })).toBe(false)
	})

	it("refuses a q of 200 CJK characters, past 600 encoded bytes, and takes 66 of them", () => {
		expect(ok({ q: "長".repeat(66) })).toBe(true)
		expect(ok({ q: "長".repeat(200) })).toBe(false)
	})

	it("refuses a value that holds a lone surrogate, which no URL can carry", () => {
		expect(ok({ q: "a\uD800b" })).toBe(false)
		expect(ok({ filter: "title.eq.\uDC00" })).toBe(false)
	})

	/* U28: a byte a form or a URL may write as three is counted as three, so an accepted request fits however it is sent */
	it("counts the widest common encoding: ~ and ! as a form writes them, a space as a URL does", () => {
		/* encodeURIComponent leaves ~ as one byte; URLSearchParams writes it as %7E */
		expect(ok({ filter: `title.eq.${"~".repeat(2039)}` })).toBe(false)
		expect(ok({ filter: `title.eq.${"~".repeat(1530)}` })).toBe(true)
		expect(ok({ q: " ".repeat(201) })).toBe(false)
	})

	it("keeps the largest accepted request within the stated query budget, however a client encodes it", () => {
		const largest = {
			cursor: "A".repeat(MAX_CURSOR_LENGTH),
			filter: at(REQUEST_BYTES.filter, "title.eq."),
			order: "id.asc",
			q: at(REQUEST_BYTES.q),
			select: "id,title",
		}
		expect(ok(largest)).toBe(true)
		const form = new URLSearchParams(largest).toString()
		const uri = Object.entries(largest)
			.map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
			.join("&")
		for (const query of [form, uri]) expect(Buffer.byteLength(query)).toBeLessThanOrEqual(MAX_QUERY_BYTES)
		/* every capped param at its cap, with its name, separator, and lang, limit and page beside them */
		const caps = MAX_CURSOR_LENGTH + REQUEST_BYTES.filter + REQUEST_BYTES.q + REQUEST_BYTES.order + REQUEST_BYTES.select
		expect(caps + 128).toBeLessThanOrEqual(MAX_QUERY_BYTES)
		expect(MAX_QUERY_BYTES).toBe(16_384 - 2048)
	})
})

describe("the cursor param takes any string, which readCursor answers (C5)", () => {
	it("passes a malformed or over-long cursor to readCursor, which refuses it as invalid_cursor", () => {
		const schema = createListQuerySchema({ sort: ["id"] })
		expect(schema.safeParse({ cursor: "abc" }).success).toBe(true)
		expect(schema.safeParse({ cursor: "A".repeat(9000) }).success).toBe(true)
	})
})

/* C3 of r17: a limit the published stamp cannot carry would be read as no stamp at all, so it is refused */
describe("createListQuerySchema's limits", () => {
	it.each([
		["maxPatternBytes", Number.POSITIVE_INFINITY],
		["maxPatternBytes", 50.5],
		["maxSortKeys", -1],
		["maxValues", Number.NaN],
		["maxFilterLength", 2 ** 53],
	])("refuses %s %s, naming the key", (key, value) => {
		expect(() => createListQuerySchema({ limits: { [key]: value }, sort: ["a"] })).toThrow(
			new TypeError(`createListQuerySchema: limits.${key} must be a whole number from 0; got ${value}`),
		)
	})

	it("takes a large whole number for a limit with no cap, and 0 where it means none (maxSortKeys takes 1 up, QL7)", () => {
		expect(() =>
			createListQuerySchema({ limits: { maxFilterLength: 0, maxPatternBytes: 1_000_000 }, sort: ["a"] }),
		).not.toThrow()
	})
})

/** A filter of `length` characters */
const filterOf = (length: number) => `a.eq.${"x".repeat(length - "a.eq.".length)}`

/* KT1 of r22b: a key set to undefined is the key left out, so the schema enforces and publishes its default */
/** What a schema with these limits publishes */
const metaOf = (limits: Record<string, undefined>) =>
	createListQuerySchema({ filter: { a: "number" }, limits, search: ["a"], sort: ["a"] }).meta()

describe("an explicit undefined list limit means the default (KT1; sibling: `NaN` and `-1` above)", () => {
	it.each(Object.keys(LIST_QUERY_LIMITS))("builds with %s set to undefined, publishing the default", (key) => {
		expect(metaOf({ [key]: undefined })).toEqual(metaOf({}))
	})

	/* AB11 of area B: the meta publishes no maxFilterLength, so only a parse pins its default */
	it("holds a filter to the default maxFilterLength when it is set to undefined", () => {
		const schema = createListQuerySchema({
			filter: { a: "string" },
			limits: { maxFilterLength: undefined },
			sort: ["a"],
		})
		expect(schema.safeParse({ filter: filterOf(LIST_QUERY_LIMITS.maxFilterLength) }).success).toBe(true)
		expect(schema.safeParse({ filter: filterOf(LIST_QUERY_LIMITS.maxFilterLength + 1) }).success).toBe(false)
	})
})

/** Build a list schema under `pagination`, deferred for toThrow */
const builtWith = (pagination: object) => () => createListQuerySchema({ pagination, sort: ["id"] })

/* QL6 of r22b: zod's .default() skips the inner check, so a default past the maximum was every request's 400 */
describe("the pagination config is checked when the schema is built (QL6 of r22b; sibling: maxPage's offset check)", () => {
	it.each([
		["maxLimit 0", { maxLimit: 0 }, "pagination.maxLimit must be a whole number from 1; got 0"],
		["maxLimit 1.5", { maxLimit: 1.5 }, "pagination.maxLimit must be a whole number from 1; got 1.5"],
		["maxLimit past 2^53", { maxLimit: 2 ** 53 }, `pagination.maxLimit must be a whole number from 1; got ${2 ** 53}`],
		[
			"defaultLimit 0",
			{ defaultLimit: 0 },
			"pagination.defaultLimit must be a whole number from 1 to maxLimit (100); got 0",
		],
		[
			"defaultLimit NaN",
			{ defaultLimit: Number.NaN },
			"pagination.defaultLimit must be a whole number from 1 to maxLimit (100); got NaN",
		],
		[
			"defaultLimit past maxLimit",
			{ defaultLimit: 11, maxLimit: 10 },
			"pagination.defaultLimit must be a whole number from 1 to maxLimit (10); got 11",
		],
		[
			"maxLimit alone below the default limit",
			{ maxLimit: 10 },
			"pagination.maxLimit 10 is below the default limit 20: set pagination.defaultLimit too",
		],
	])("refuses %s as a TypeError naming the key", (_label, pagination, message) => {
		expect(builtWith(pagination)).toThrow(new TypeError(`createListQuerySchema: ${message}`))
	})

	it("checks maxLimit before maxPage's offset multiplies by it", () => {
		expect(builtWith({ maxLimit: Number.NaN, maxPage: 2 })).toThrow("pagination.maxLimit must be a whole number from 1")
	})

	it("takes a limit config within its bounds, the default from 1 up to maxLimit", () => {
		for (const pagination of [
			{ maxLimit: 1, defaultLimit: 1 },
			{ maxLimit: 20 },
			{ defaultLimit: 100 },
			{ defaultLimit: 7, maxLimit: 7 },
		])
			expect(builtWith(pagination), JSON.stringify(pagination)).not.toThrow()
		expect(createListQuerySchema({ pagination: { defaultLimit: 3, maxLimit: 10 }, sort: ["id"] }).parse({}).limit).toBe(
			3,
		)
	})
})

/* QL7 of r22b: a malformed order entry was dropped, so `order=asc` was a 200 sorted by the default, descending */
describe("a malformed order is an issue on order (QL7 of r22b; sibling: the published pattern)", () => {
	const schema = createListQuerySchema({ sort: ["created_at", "title"] })
	const pattern = new RegExp(
		String(z.toJSONSchema(schema, { io: "input" }).properties?.["order"]?.["pattern" as never]),
	)

	it.each([
		["asc", '"asc"'],
		["desc", '"desc"'],
		[".desc", '".desc"'],
		[",", '""'],
		["title.asc,", '""'],
		/* AB9 of area B: an entry with whitespace around it, which the pattern refuses, is named as sent */
		[" title.asc", '" title.asc"'],
		["title.asc ", '"title.asc "'],
		["title.asc, created_at.desc", '" created_at.desc"'],
		["\ttitle", '"\\ttitle"'],
		["   ", '"   "'],
	])("refuses %j, naming the entry, as the published pattern does", (order, named) => {
		const result = schema.safeParse({ order })
		expect(result.error?.issues).toEqual([
			expect.objectContaining({ message: `Malformed sort entry: ${named}`, path: ["order"] }),
		])
		expect(pattern.test(order)).toBe(false)
	})

	/* AB9 of area B: the last entry won sortOrderBy while parsedSort kept both, so the two disagreed */
	it("refuses a field named twice, naming it once, so sortOrderBy and parsedSort agree", () => {
		for (const order of ["title.asc,title.desc", "title,created_at,title.desc"]) {
			const result = schema.safeParse({ order })
			expect(result.error?.issues, order).toEqual([
				expect.objectContaining({ message: 'Sort field named twice: "title"', path: ["order"] }),
			])
		}
	})

	it("takes a well-formed order, as the pattern does", () => {
		expect(schema.parse({ order: "title.asc,created_at.desc" }).parsedSort).toEqual([
			{ direction: "asc", field: "title" },
			{ direction: "desc", field: "created_at" },
		])
		expect(pattern.test("title.asc,created_at.desc")).toBe(true)
	})

	it("refuses maxSortKeys 0 at build, which no order could meet while the pattern admits one key", () => {
		expect(() => createListQuerySchema({ limits: { maxSortKeys: 0 }, sort: ["title"] })).toThrow(
			new TypeError("createListQuerySchema: limits.maxSortKeys must be a whole number from 1; got 0"),
		)
	})
})
