import { describe, expect, it } from "vitest"
import { createListQuerySchema } from "./list-schema.ts"
import { createRetrieveQuerySchema } from "./retrieve-schema.ts"
import * as schema from "./schema.ts"
import { LIST_QUERY_LIMITS, PAGINATION_DEFAULTS } from "./schema-limits.ts"

const page = { count: 4, hasMore: false, limit: 20, nextCursor: null, page: 1 }

describe("paginationResponseSchema", () => {
	it("accepts an offset page and a cursor page, whose count and page are null", () => {
		expect(schema.paginationResponseSchema.parse(page)).toEqual(page)
		const cursorPage = { count: null, hasMore: true, limit: 20, nextCursor: "abc", page: null }
		expect(schema.paginationResponseSchema.parse(cursorPage)).toEqual(cursorPage)
	})

	it.each([{ count: -1 }, { limit: 0 }, { page: 0 }])("refuses %o", (bad) => {
		expect(schema.paginationResponseSchema.safeParse({ ...page, ...bad }).success).toBe(false)
	})
})

describe("schema.ts", () => {
	it("re-exports every builder and constant from the module that defines it", () => {
		expect(schema).toMatchObject({
			createListQuerySchema,
			createRetrieveQuerySchema,
			LIST_QUERY_LIMITS,
			PAGINATION_DEFAULTS,
		})
	})
})
