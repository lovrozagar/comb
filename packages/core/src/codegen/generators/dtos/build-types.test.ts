import { describe, expect, it } from "vitest"
import { plain } from "./build-types.ts"

describe("plain", () => {
	it("is a base that takes no null of its own, with the keys and shared schemas it is given or none", () => {
		expect(plain("z.string()")).toEqual({ code: "z.string()", keys: {}, takesNull: false, uses: [] })
		expect(plain("cidrSchema", { "x-comb-text": "rule" }, ["cidrSchema"])).toEqual({
			code: "cidrSchema",
			keys: { "x-comb-text": "rule" },
			takesNull: false,
			uses: ["cidrSchema"],
		})
	})
})
