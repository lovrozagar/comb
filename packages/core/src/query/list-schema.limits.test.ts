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
