import { describe, expect, it } from "vitest"
import { categoryRanges, complement, union, utf8Length, utf8Weight } from "./pattern-unicode.ts"

describe("union", () => {
	it("merges overlapping and touching ranges, in order", () => {
		expect(
			union([
				[10, 12],
				[0, 3],
				[4, 5],
				[11, 20],
			]),
		).toEqual([
			[0, 5],
			[10, 20],
		])
	})

	it("cuts a range around the surrogates, and drops one inside them", () => {
		expect(union([[0xd000, 0xe000]])).toEqual([
			[0xd000, 0xd7ff],
			[0xe000, 0xe000],
		])
		expect(union([[0xd900, 0xda00]])).toEqual([])
	})
})

describe("complement", () => {
	it("is every scalar value the set leaves out", () => {
		expect(complement([[0x41, 0x5a]])).toEqual([
			[0, 0x40],
			[0x5b, 0xd7ff],
			[0xe000, 0x10ffff],
		])
		expect(complement([[0, 0x10ffff]])).toEqual([])
	})
})

describe("categoryRanges", () => {
	it("reads a General_Category as the runtime's \\p{…} matches it, each scalar value once", () => {
		const set = categoryRanges("Lu")
		const holds = (code: number) => set.some(([lo, hi]) => lo <= code && code <= hi)
		expect(holds(0x41) && holds(0x5a) && holds(0x10400)).toBe(true)
		expect(holds(0x61) || holds(0x30)).toBe(false)
		expect(categoryRanges("Lu")).toBe(set)
	})

	it("holds no surrogate, even for the category of none", () => {
		expect(categoryRanges("Cs")).toEqual([])
	})
})

describe("UTF-8 sizes", () => {
	it("counts a scalar value's bytes", () => {
		expect([0x7f, 0x80, 0x7ff, 0x800, 0xffff, 0x10000].map(utf8Length)).toEqual([1, 2, 2, 3, 3, 4])
	})

	it("weighs a class by the byte sequences Rust's regex splits it into", () => {
		expect(utf8Weight([[0x41, 0x5a]])).toBe(1)
		/* 0x80-0x7ff is one two-byte sequence, [C2-DF][80-BF] */
		expect(utf8Weight([[0x80, 0x7ff]])).toBe(2)
		/* 0x7f-0x80 crosses a length: one 1-byte and one 2-byte sequence */
		expect(utf8Weight([[0x7f, 0x80]])).toBe(3)
		/* 0x81-0xc0 splits at 0xbf into two 2-byte sequences */
		expect(utf8Weight([[0x81, 0xc0]])).toBe(4)
	})
})
