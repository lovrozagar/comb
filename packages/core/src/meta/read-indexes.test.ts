import { describe, expect, it } from "vitest"
import { readPartialUniqueIndexes, readUniqueIndexes } from "./read-indexes.ts"

/* C7 of the 0.14.1 review: a partial unique index is read with its predicate, or not at all */
describe("readPartialUniqueIndexes", () => {
	it("reads an absent list as none, and each index with its predicate", () => {
		expect(readPartialUniqueIndexes(undefined)).toEqual([])
		const live = { columns: ["email"], name: "u_email", where: "deleted_at IS NULL" }
		expect(readPartialUniqueIndexes([live])).toEqual([live])
	})

	it("refuses one with no predicate, which would read as the uniqueness it is not, and any malformed list", () => {
		for (const raw of [
			[{ columns: ["email"], name: "u_email" }],
			[{ columns: ["email"], name: "u_email", where: "" }],
			[{ columns: [], name: "u_email", where: "x" }],
			{ columns: ["email"] },
		])
			expect(readPartialUniqueIndexes(raw), JSON.stringify(raw)).toBe("invalid")
	})
})

describe("readUniqueIndexes", () => {
	it("reads an absent list as none, and refuses an index without columns or a name", () => {
		expect(readUniqueIndexes(undefined)).toEqual([])
		expect(readUniqueIndexes([{ columns: ["a"], name: "u" }])).toEqual([{ columns: ["a"], name: "u" }])
		expect(readUniqueIndexes([{ columns: ["a"] }])).toBe("invalid")
		expect(readUniqueIndexes(["u"])).toBe("invalid")
	})
})
