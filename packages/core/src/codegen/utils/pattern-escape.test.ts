import { describe, expect, it } from "vitest"
import { escapeAt, hexOf, LOOKAROUND, refuse, Unportable } from "./pattern-escape.ts"

describe("escapeAt", () => {
	it("takes an escape every engine reads alike, and gives its last index", () => {
		expect(escapeAt("\\.", 0)).toEqual({ end: 1, refused: null })
		expect(escapeAt("\\x41", 0)).toEqual({ end: 3, refused: null })
		expect(escapeAt("a\\p{Lu}", 1)).toEqual({ end: 6, refused: null })
	})

	it("refuses one an engine reads otherwise, naming the spelling to write", () => {
		expect(escapeAt("\\d", 0).refused).toContain("write [0-9]")
		expect(escapeAt("\\0", 0).refused).toContain("write \\x00")
		expect(escapeAt("\\1", 0).refused).toContain("a backreference")
		expect(escapeAt("\\u0041", 0)).toEqual({ end: 5, refused: expect.stringContaining("write \\x41") })
		expect(escapeAt("\\u2028", 0).refused).toContain("write \\p{Zl}")
		expect(escapeAt("\\cJ", 0)).toEqual({ end: 2, refused: expect.stringContaining("write \\x0A") })
		expect(escapeAt("\\p{Script=Latin}", 0).refused).toMatch(/^\\p\{Script=Latin\}, /)
	})
})

describe("the escape tables", () => {
	it("names the categories every engine compiles, Cs not among them", () => {
		expect(["\\p{L}", "\\P{Lu}", "\\p{Cs}"].map((escape) => escapeAt(escape, 0).refused === null)).toEqual([
			true,
			true,
			false,
		])
	})

	it("spells a code as \\xHH, and tells a lookaround from a named group", () => {
		expect([hexOf(0x0a), hexOf(0xff)]).toEqual(["\\x0A", "\\xFF"])
		expect(["(?=a)", "(?<!a)", "(?<n>a)"].map((open) => LOOKAROUND.test(open))).toEqual([true, true, false])
	})

	it("ends a scan with Unportable", () => {
		expect(() => refuse("held")).toThrow(new Unportable("held"))
	})
})
