import { RE2JS } from "re2js"
import { describe, expect, it } from "vitest"
import { bracket } from "./pattern-class.ts"
import { CATEGORIES } from "./pattern-escape.ts"
import { patternLiteral } from "./pattern.ts"
import { rangesText } from "./pattern-ranges.ts"
import { categoryRanges, complement, union } from "./pattern-unicode.ts"

/* AA4-2 of r24: a \p{…} names another set on each Unicode version an engine ships, so comb publishes
   the ranges of the codegen runtime's tables, read back here as the set they match */
const source = (literal: string): string => literal.slice(1, -2)

/* the set the class at the start of `text` matches */
const classSet = (text: string) => bracket(text, 0).set

describe("patternLiteral: a General_Category published as its ranges (AA4-2)", () => {
	it.each([...CATEGORIES].filter((name) => name !== "Zl" && name !== "Zp"))(
		"writes \\p{%s} and \\P{%s} as the classes of exactly the runtime's set",
		(name) => {
			const set = categoryRanges(name)
			const plain = source(patternLiteral(`/\\p{${name}}/u`, "x"))
			const negated = source(patternLiteral(`/\\P{${name}}/u`, "x"))
			for (const text of [plain, negated]) {
				expect(text).not.toMatch(/\\[pP]\{(?!Z[lp]\})/u)
				expect(() => RE2JS.compile(text)).not.toThrow()
			}
			expect(classSet(plain)).toEqual(set)
			expect(classSet(negated)).toEqual(complement(set))
		},
	)

	it("folds a class's negation and other members into one class of its set", () => {
		const text = source(patternLiteral(String.raw`/^[^\p{L}a-z\x26]$/u`, "x"))
		expect(text.startsWith("^[") && !text.startsWith("^[^")).toBe(true)
		expect(classSet(text.slice(1))).toEqual(complement(union([...categoryRanges("L"), [0x26, 0x26]])))
	})

	it("keeps \\p{Zl} and \\p{Zp}, the one way every engine reads U+2028 and U+2029, by name", () => {
		expect(patternLiteral(String.raw`/^\p{Zl}\p{Zp}$/u`, "x")).toBe(String.raw`/^\p{Zl}\p{Zp}$/u`)
		const text = source(patternLiteral(String.raw`/^\p{Z}$/u`, "x"))
		expect(text).toMatch(/\\p\{Zl\}\\p\{Zp\}\]\$$/u)
		expect(text).not.toMatch(/[\u2028\u2029]/u)
		expect(classSet(text.slice(1))).toEqual(categoryRanges("Z"))
	})

	it("writes a control as \\xHH and a class syntax character escaped, and leaves a source with no \\p as written", () => {
		const members = rangesText([
			[0x00, 0x1f],
			[0x26, 0x26],
			[0x2d, 0x2d],
			[0x41, 0x42],
			[0x5b, 0x5b],
			[0x5c, 0x5c],
			[0x5e, 0x5e],
			[0x7e, 0x7e],
			[0x85, 0x85],
			[0x2027, 0x202a],
		])
		expect(members).toBe(`${String.raw`\x00-\x1F\x26\-AB\[\\\^\x7E\x85`}\u2027\u202A${String.raw`\p{Zl}\p{Zp}`}`)
		for (const engine of [(text: string) => new RegExp(text, "u"), (text: string) => RE2JS.compile(text)])
			expect(() => engine(`[${members}]`)).not.toThrow()
		expect(patternLiteral(String.raw`/^[\-\[\]&~]\x41$/u`, "x")).toBe(String.raw`/^[\-\[\]&~]\x41$/u`)
	})

	it("matches scalar values only, so a lone surrogate \\P{L} took is not taken", () => {
		const regex = new Function(`return ${patternLiteral(String.raw`/^\P{L}$/u`, "x")}`)() as RegExp
		expect([regex.test("\uD800"), new RegExp(String.raw`^\P{L}$`, "u").test("\uD800")]).toEqual([false, true])
	})
})
