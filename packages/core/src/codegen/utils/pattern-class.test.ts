import { describe, expect, it } from "vitest"
import { bracket, escapeSet } from "./pattern-class.ts"
import { Unportable } from "./pattern-escape.ts"
import { categoryRanges, complement } from "./pattern-unicode.ts"

describe("escapeSet", () => {
	it("reads an escape as the one character it matches", () => {
		expect(escapeSet("\\x41", 0)).toEqual({ class: false, end: 3, items: 1, set: [[0x41, 0x41]] })
		expect(escapeSet("\\n", 0).set).toEqual([[0x0a, 0x0a]])
		expect(escapeSet("\\.", 0).set).toEqual([[0x2e, 0x2e]])
	})

	it("reads \\p and \\P as a category and its complement", () => {
		expect(escapeSet("\\p{Lu}", 0)).toEqual({ class: true, end: 5, items: 1, set: categoryRanges("Lu") })
		expect(escapeSet("\\P{Lu}", 0).set).toEqual(complement(categoryRanges("Lu")))
	})

	it("refuses an escape an engine reads otherwise", () => {
		expect(() => escapeSet("\\d", 0)).toThrow(Unportable)
	})
})

describe("bracket", () => {
	it("reads a class's members and ranges into one set, and its ]", () => {
		expect(bracket("[a-cx\\x41]", 0)).toEqual({
			class: true,
			end: 9,
			items: 3,
			set: [
				[0x41, 0x41],
				[0x61, 0x63],
				[0x78, 0x78],
			],
		})
	})

	it("reads a - before ] as the character, and a negated class as the complement", () => {
		expect(bracket("[a-]", 0).set).toEqual([
			[0x2d, 0x2d],
			[0x61, 0x61],
		])
		expect(bracket("[^\\x00-\u{10FFFF}]", 0).set).toEqual([])
	})

	it("refuses what Rust's regex or Go's RE2 reads otherwise in a class", () => {
		for (const source of ["[]", "[^]", "[a[]", "[a&&b]", "[a--b]", "[a-&&]"])
			expect(() => bracket(source, 0), source).toThrow(Unportable)
	})
})
