/** createListQuerySchema's construction checks: extension names it reserves, and the page bound */
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createListQuerySchema } from "./list-schema.ts"
import { PAGINATION_DEFAULTS } from "./schema-limits.ts"

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
	it("takes pages up to maxPage, 10 000 by default, and refuses one past it", () => {
		const schema = createListQuerySchema({ sort: ["id"] })
		expect(PAGINATION_DEFAULTS.maxPage).toBe(10_000)
		expect(schema.safeParse({ page: "10000" }).success).toBe(true)
		expect(schema.safeParse({ page: "10001" }).success).toBe(false)
		expect(schema.safeParse({ page: String(Number.MAX_SAFE_INTEGER) }).success).toBe(false)
	})

	it("takes a maxPage of its own, and refuses one whose last offset is past 2^53 - 1", () => {
		const schema = createListQuerySchema({ pagination: { maxPage: 3 }, sort: ["id"] })
		expect(schema.safeParse({ page: "3" }).success).toBe(true)
		expect(schema.safeParse({ page: "4" }).success).toBe(false)
		expect(() =>
			createListQuerySchema({ pagination: { maxLimit: 2000, maxPage: Number.MAX_SAFE_INTEGER }, sort: ["id"] }),
		).toThrow(TypeError)
		expect(() => createListQuerySchema({ pagination: { maxPage: 0 }, sort: ["id"] })).toThrow(TypeError)
	})
})

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

	it("keeps the whole query string of the largest accepted request under 16 KB", () => {
		const largest = {
			cursor: "A".repeat(8192),
			filter: `title.eq.${"%".repeat(Math.floor((5120 - 18) / 3))}`,
			order: "id.asc",
			q: "%".repeat(200),
			select: "id,title",
		}
		expect(ok(largest)).toBe(true)
		const query = new URLSearchParams(largest).toString()
		expect(Buffer.byteLength(query)).toBeLessThan(15_500)
	})
})

describe("the cursor param takes any string, which readCursor answers (C5)", () => {
	it("passes a malformed or over-long cursor to readCursor, which refuses it as invalid_cursor", () => {
		const schema = createListQuerySchema({ sort: ["id"] })
		expect(schema.safeParse({ cursor: "abc" }).success).toBe(true)
		expect(schema.safeParse({ cursor: "A".repeat(9000) }).success).toBe(true)
	})
})
