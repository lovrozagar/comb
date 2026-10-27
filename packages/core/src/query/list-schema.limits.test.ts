/** createListQuerySchema's construction checks: extension names it reserves, and the page bound */
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createListQuerySchema } from "./list-schema.ts"
import { MAX_CURSOR_LENGTH } from "./cursor.ts"
import { MAX_QUERY_BYTES, PAGINATION_DEFAULTS, REQUEST_BYTES } from "./schema-limits.ts"

const RESERVED = [
	"cursor",
	"filter",
	"filterAst",
	"lang",
	"limit",
	"order",
	"page",
	"parsedFields",
	"parsedSort",
	"q",
	"select",
	"sortOrderBy",
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
		const schema = createListQuerySchema({ extend: { archived: z.enum(["yes"]).optional() }, sort: ["id"] })
		expect(schema.parse({ archived: "yes" }).archived).toBe("yes")
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
