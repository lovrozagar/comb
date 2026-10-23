/**
 * searchText over every Unicode scalar value (R5). Its fold must not depend on context: a stored
 * word and a query term are folded apart, so a letter that folds one way at a word end and another
 * inside a word breaks every prefix search ending in it. JavaScript's only context-sensitive
 * lowercase is the final sigma: toLowerCase writes Σ as ς at a word end and σ elsewhere.
 */
import { describe, expect, it } from "vitest"
import { searchText } from "./search.ts"

/** Every scalar value, surrogates left out */
function* scalars(): Generator<string> {
	for (let point = 0; point <= 0x10ffff; point++) {
		if (point >= 0xd800 && point <= 0xdfff) continue
		yield String.fromCodePoint(point)
	}
}

describe("searchText over every scalar value (R5)", () => {
	it("folds each the same alone, before a letter and after one", () => {
		const context: string[] = []
		for (const c of scalars()) {
			const alone = searchText(c)
			if (searchText(`${c}a`) !== `${alone}a` || searchText(`a${c}`) !== `a${alone}`) context.push(c)
		}
		expect(context).toEqual([])
	}, 120_000)

	it("is idempotent", () => {
		const unstable: string[] = []
		for (const c of scalars()) if (searchText(searchText(c)) !== searchText(c)) unstable.push(c)
		expect(unstable).toEqual([])
	}, 120_000)

	it("keeps the Cyrillic letters a mark makes and Hangul syllables whole, and folds Latin and Greek marks (R12)", () => {
		expect(searchText("й")).toBe("й")
		expect(searchText("Ї")).toBe("ї")
		expect(searchText("ёлка")).toBe("ёлка")
		expect(searchText("и")).not.toBe(searchText("й"))
		expect(searchText("가")).toBe("가")
		expect(searchText("ά")).toBe("α")
		expect(searchText("Café Ærø")).toBe("cafe aero")
	})

	it("finds an uppercase Greek prefix ending in Σ in the stored word", () => {
		expect(searchText("ΚΟΣΜΟΣ")).toBe("κοσμοσ")
		expect(searchText("ΚΟΣΜΟΣ").includes(searchText("ΚΟΣ"))).toBe(true)
		expect(searchText("Οδυσσέας").includes(searchText("ΟΔΥΣ"))).toBe(true)
	})
})

/* U7 of the 0.12 round: a mark after a Cyrillic letter stays only where it makes a letter of its own */
describe("searchText on Cyrillic marks", () => {
	it.each([
		["й", "й"],
		["ё", "ё"],
		["ї", "ї"],
		["ў", "ў"],
		["ѝ", "ѝ"],
	])("keeps the mark that makes %s a letter", (text, folded) => {
		expect(searchText(text)).toBe(folded)
	})

	it.each([
		["доро́га", "дорога"],
		["а́", "а"],
		["Москва́", "москва"],
	])("drops a stress mark, which makes no letter: %s", (text, folded) => {
		expect(searchText(text)).toBe(folded)
	})

	it("keeps a letter's own mark and drops a stress mark in one word", () => {
		expect(searchText("йо́д")).toBe("йод")
		expect(searchText("ё́ж")).toBe("ёж")
	})
})
