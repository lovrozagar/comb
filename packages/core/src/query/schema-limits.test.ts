import { describe, expect, it } from "vitest"
import { FILTER_LIMITS } from "./filter.ts"
import { LIST_QUERY_LIMITS, PAGINATION_DEFAULTS } from "./schema-limits.ts"

/** Values a keyset predicate over `keys` sort keys binds: each branch's equalities, its step, the id */
const keyset = (keys: number) => (keys * (keys + 1)) / 2 + keys + 1

describe("schema-limits", () => {
	it("pages 20 rows by default and at most 100", () => {
		expect(PAGINATION_DEFAULTS).toEqual({ defaultLimit: 20, maxLimit: 100 })
	})

	it("bounds a list request by the filter limits plus length, search words and sort keys", () => {
		expect(LIST_QUERY_LIMITS).toEqual({ ...FILTER_LIMITS, maxFilterLength: 2048, maxSearchTerms: 8, maxSortKeys: 3 })
	})

	it("keeps the worst accepted request within D1's 100 bound parameters, with 20 to spare", () => {
		const worst =
			LIST_QUERY_LIMITS.maxValues + LIST_QUERY_LIMITS.maxSearchTerms + keyset(LIST_QUERY_LIMITS.maxSortKeys) + 2
		expect(worst).toBe(80)
	})
})
