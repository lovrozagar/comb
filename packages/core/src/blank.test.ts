import { describe, expect, it } from "vitest"
import { blank, nonBlank } from "./blank.ts"

describe("blank", () => {
	it.each([
		["", true],
		["  \t\n", true],
		[" ", true],
		[" x ", false],
	])("reads %j as blank: %s", (value, expected) => {
		expect(blank(value)).toBe(expected)
	})
})

describe("nonBlank", () => {
	it("takes a value with any non-space character, as it is, and refuses a blank one with its message", () => {
		expect(nonBlank().parse(" ./m ")).toBe(" ./m ")
		expect(nonBlank().safeParse(" ").error?.issues[0]?.message).toBe("must not be blank")
		expect(nonBlank("name it").safeParse("").error?.issues[0]?.message).toBe("name it")
	})
})
