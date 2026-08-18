import { describe, expect, it } from "vitest"
import { likePattern } from "../../../src/query/like.ts"

describe("likePattern", () => {
	it("expands * after escaping % and _", () => {
		expect(likePattern("*foo*")).toBe("%foo%")
		expect(likePattern("%")).toBe("\\%")
		expect(likePattern("_")).toBe("\\_")
		expect(likePattern("*100%*")).toBe("%100\\%%")
	})
})
