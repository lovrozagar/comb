import { describe, expect, it } from "vitest"
import { lossy, NO_KEYSET_CAUSE, refuseComputedSort, refuseRoundedId, refuseUncarried } from "./cursor-refusals.ts"
import type { SortField } from "./types.ts"

const BY_K: SortField[] = [{ direction: "asc", field: "k" }]

/** Why refuseUncarried refuses `row` under BY_K, or null when it takes it */
function cause(row: Record<string, unknown>): string | null {
	try {
		refuseUncarried(row, BY_K, "id")
	} catch (error) {
		return (error as { cause: string }).cause
	}
	return null
}

/* mintCursor runs these on every row a page serves (cursor.test.ts holds them through it) */
describe("what no cursor resumes after", () => {
	it("calls an integer lossy only past ±(2^53 − 1)", () => {
		expect([2 ** 53 - 1, -(2 ** 53 - 1), 2 ** 53, -(2 ** 53), 1.5, "9007199254740993"].map(lossy)).toEqual([
			false,
			false,
			true,
			true,
			false,
			false,
		])
	})

	it("refuses a rounded tiebreak id by name, and takes a safe one", () => {
		expect(() => refuseRoundedId({ _id: 2 ** 60 }, "_id")).toThrow(
			expect.objectContaining({ cause: expect.stringContaining("the tiebreak id _id reads"), status: 500 }),
		)
		expect(() => refuseRoundedId({ _id: 2 ** 53 - 1 }, "_id")).not.toThrow()
	})

	it("refuses a computed sort as cursor_pagination_unsupported, and takes a column order", () => {
		expect(() => refuseComputedSort([{ direction: "desc", field: "@relevance" }])).toThrow(
			expect.objectContaining({ cause: NO_KEYSET_CAUSE, errorKey: "cursor_pagination_unsupported", status: 400 }),
		)
		expect(() => refuseComputedSort(BY_K)).not.toThrow()
	})

	it("refuses a missing key before a value no cursor carries, and that before the id", () => {
		expect(cause({ id: { a: 1 } })).toContain("each row's k")
		expect(cause({ id: { a: 1 }, k: { a: 1 } })).toContain("the sort by k reads an object")
		expect(cause({ id: { a: 1 }, k: 1 })).toContain("the tiebreak id id reads an object")
		expect(cause({ id: "a", k: 1 })).toBeNull()
	})
})
