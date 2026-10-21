import { describe, expect, it } from "vitest"
import { escapeLike, likePattern } from "./like.ts"
import { escapeLike as exported } from "./index.ts"

describe("likePattern", () => {
	it("expands * after escaping % and _", () => {
		expect(likePattern("*foo*")).toBe("%foo%")
		expect(likePattern("%")).toBe("\\%")
		expect(likePattern("_")).toBe("\\_")
		expect(likePattern("*100%*")).toBe("%100\\%%")
	})
})

describe("escapeLike (C4)", () => {
	it("escapes LIKE's specials and its escape character, for a pattern with ESCAPE '\\'", () => {
		expect(escapeLike("50%_off\\now")).toBe("50\\%\\_off\\\\now")
		expect(escapeLike("plain")).toBe("plain")
		expect(exported).toBe(escapeLike)
	})
})
