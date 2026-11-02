import { describe, expect, it } from "vitest"
import { plain } from "./build-types.ts"

describe("plain", () => {
	it("is a base that takes no null of its own, with the keys it is given or none", () => {
		expect(plain("z.string()")).toEqual({ code: "z.string()", keys: {}, takesNull: false })
		expect(plain("z.string()", { "x-comb-text": "rule" })).toEqual({
			code: "z.string()",
			keys: { "x-comb-text": "rule" },
			takesNull: false,
		})
	})
})
