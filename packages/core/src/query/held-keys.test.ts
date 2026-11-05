import { describe, expect, it } from "vitest"
import { heldValue, isStoredKey, isTextKeys, isUnprinted, textKeysOf, unprintedNumber } from "./held-keys.ts"
import type { SortField } from "./types.ts"

const SORT: SortField[] = [
	{ direction: "asc", field: "k" },
	{ direction: "desc", field: "name" },
]

/* AB4-2 of area B: a SQLite key's stored value of a class its mode reads as another, held apart */
describe("_combTextKeys (AB4-2 of area B; sibling: _combKeyTexts)", () => {
	it("takes a held key per sort key, a class and its text, null or a REAL's unprinted mark, or none", () => {
		expect(isTextKeys('[["real","0.1"],null]', SORT)).toBe(true)
		expect(isTextKeys('["!n7.0631582885980606e+300",null]', SORT)).toBe(true)
		expect(isTextKeys("", SORT)).toBe(true)
		for (const value of ['[["real","0.1"]]', '[["date","x"],null]', '["n7",null]', "[", 7])
			expect(isTextKeys(value, SORT), String(value)).toBe(false)
	})

	it("reads each key's held value from the row, and none from a row that holds none", () => {
		expect(textKeysOf({ _combTextKeys: '[["text","a"],null]' })).toEqual([["text", "a"], null])
		expect(textKeysOf({ _combTextKeys: "" })).toBeUndefined()
		expect(textKeysOf({})).toBeUndefined()
	})

	it("carries a stored value as the cursor binds it, its class's own JS value", () => {
		expect(heldValue(["integer", "7"])).toBe(7)
		expect(heldValue(["integer", "9007199254740993"])).toBe(9_007_199_254_740_993n)
		expect(heldValue(["real", "9e999"])).toBe(Number.POSITIVE_INFINITY)
		expect(heldValue(["text", "a"])).toBe("a")
		expect(heldValue(["blob", "00ff"])).toEqual(new Uint8Array([0, 255]))
		expect(heldValue(["blob", ""])).toEqual(new Uint8Array([]))
	})
})

/* AB4-7 of area B: a REAL SQLite prints no text of that reads back as it, marked `!n` before its printf text */
describe("the unprinted mark (AB4-7 of area B; sibling: the held stored values)", () => {
	it("tells an unprinted key from a stored value and from null, and reads the number its text prints", () => {
		const mark = "!n7.0631582885980606e+300"
		expect(isUnprinted(mark)).toBe(true)
		for (const key of ["n7", "!f", null, ["real", "1"]]) expect(isUnprinted(key), JSON.stringify(key)).toBe(false)
		expect(isStoredKey(mark)).toBe(false)
		expect(isStoredKey(null)).toBe(false)
		expect(isStoredKey(["real", "1"])).toBe(true)
		expect(unprintedNumber(mark)).toBe(7.063_158_288_598_06e300)
	})
})
