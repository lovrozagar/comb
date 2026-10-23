import { describe, expect, it } from "vitest"
import { queryHelpers } from "./drizzle.ts"
import { SEALED } from "./__fixtures__/cursor-secret.ts"

/* U5 of the 0.12 round: listOptions bounds a page no schema validated as buildListQuery does */
describe("queryHelpers.listOptions on a page no schema validated", () => {
	it.each([
		[50_000, "page_too_deep"],
		[0, "invalid_page"],
		[1.5, "invalid_page"],
	])("refuses page %s with %s", (page, errorKey) => {
		expect(() => queryHelpers.listOptions({ limit: 20, page, parsedSort: [], sortOrderBy: {} }, SEALED)).toThrow(
			expect.objectContaining({ errorKey, status: 400 }),
		)
	})

	it("takes a whole page within the cap", () => {
		expect(queryHelpers.listOptions({ limit: 20, page: 3, parsedSort: [], sortOrderBy: {} }, SEALED).offset).toBe(40)
	})
})
