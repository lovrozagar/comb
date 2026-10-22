import { describe, expect, it } from "vitest"
import { constraintsOfText } from "./constraint-reader.ts"

describe("constraintsOfText: numbers as runtime reads them (F2, F3)", () => {
	it.each([
		["1e3", 1000],
		["0x40", 64],
		["+1", 1],
		[".5", 0.5],
		["1e-7", 1e-7],
		["5e-7", 5e-7],
		["1e21", 1e21],
		["0b101", 5],
		["0o17", 15],
		["1_000", 1000],
		["-5", -5],
		["-0.25", -0.25],
	])("reads max: %s as %d", (written, value) => {
		expect(constraintsOfText(`c.real("x", { max: ${written} })`)).toEqual({ max: value })
	})
})

describe("constraintsOfText: what a constraint object may hold (F2)", () => {
	it("reads a shorthand property as the const it names, and fails where that name is bound nowhere", () => {
		expect(constraintsOfText('c.text("x", { trim: true, "max": 5 })')).toEqual({ max: 5, trim: true })
		expect(() => constraintsOfText('c.text("x", { max })')).toThrow(/comb cannot read max: max is not a const/)
	})

	it.each([
		["a spread", 'c.text("x", { ...LIM })', /a constraint object takes plain properties/],
		["a computed name", 'c.text("x", { ["max"]: 5 })', /a constraint object takes plain properties/],
		["arithmetic", 'c.text("x", { max: -N + 14 })', /-N \+ 14 is computed, not a literal/],
		["a product", 'c.text("x", { max: 7 * 1 })', /7 \* 1 is computed, not a literal/],
		["a bitwise not", 'c.text("x", { max: ~1 })', /~1 is computed, not a literal/],
	])("fails on %s, naming it, rather than drop the bound", (_, raw, why) => {
		expect(() => constraintsOfText(raw)).toThrow(why)
	})
})

describe("constraintsOfText: strings and the other forms (F4)", () => {
	it("reads an inline string as TypeScript does, as a const of the same text is read", () => {
		/* the source text "/^\d+$/" is the string /^d+$/ at runtime, inline or in a const */
		expect(constraintsOfText(String.raw`c.text("x", { pattern: "/^\d+$/" })`)).toEqual({ pattern: "/^d+$/" })
		expect(constraintsOfText(String.raw`c.text("x", { pattern: "/^\\d+$/" })`)).toEqual({
			pattern: String.raw`/^\d+$/`,
		})
		expect(constraintsOfText(String.raw`c.text("x", { pattern: /^\d+$/ })`)).toEqual({ pattern: String.raw`/^\d+$/` })
	})

	it("reads the type-argument form, and nothing from c.enum, a call without an object, or another helper", () => {
		expect(constraintsOfText('c.text<{ max: 10; trim: true; pattern: "/a/" }>("n")')).toEqual({
			max: 10,
			pattern: "/a/",
			trim: true,
		})
		expect(constraintsOfText('c.enum("s", ["a"], { terminal: ["a"] })')).toEqual({})
		expect(constraintsOfText('c.text("n").notNull()')).toEqual({})
		expect(constraintsOfText('c.text<string>("n")')).toEqual({})
		expect(constraintsOfText('text("n", { length: 5 })')).toEqual({})
		expect(constraintsOfText('c.json("m", schema, { maxBytes: 9 }).default({ max: 1 })')).toEqual({ maxBytes: 9 })
	})

	it("reads the object through `as`, `satisfies` and parentheses, and false in the type form", () => {
		expect(constraintsOfText('c.text("x", { max: 5 } as const)')).toEqual({ max: 5 })
		expect(constraintsOfText('c.text("x", ({ max: 5 }) satisfies Limits)')).toEqual({ max: 5 })
		expect(constraintsOfText('c.text<{ trim: false; max: 3 }>("n")')).toEqual({ max: 3, trim: false })
	})

	it("fails on a type argument that writes no literal type", () => {
		expect(() => constraintsOfText('c.text<{ max: number }>("n")')).toThrow(/a constraint type takes literal types/)
	})
})
