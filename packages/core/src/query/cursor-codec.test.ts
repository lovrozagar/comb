import { describe, expect, it } from "vitest"
import {
	carried,
	CursorRef,
	decodeId,
	decodeValue,
	encodeValue,
	RealText,
	realTextOf,
	sameValue,
} from "./cursor-codec.ts"

/** `value` as the cursor carries it: encoded, written as JSON and read back */
const roundTrip = (value: unknown): unknown => decodeValue(JSON.parse(JSON.stringify(encodeValue(value))))

/* QL5 of r22b: the codec is closed over what a mint takes, so every cursor comb mints is one it reads */
describe("the cursor codec reads back every value a key column reads (QL5 of r22b; sibling: what it refuses)", () => {
	const KEY_VALUES: [string, unknown][] = [
		["null", null],
		["true", true],
		["false", false],
		["an empty string", ""],
		["a string", "é東"],
		["0", 0],
		["a fraction", -1.5],
		["the largest safe integer", Number.MAX_SAFE_INTEGER],
		["Infinity", Number.POSITIVE_INFINITY],
		["-Infinity", Number.NEGATIVE_INFINITY],
		["NaN", Number.NaN],
		["a bigint", 7n],
		["the least int64", -(2n ** 63n)],
		["the largest uint64", 2n ** 64n - 1n],
		["a Date", new Date(1_700_000_000_123)],
		["a Date no JS Date holds", new Date(Number.NaN)],
		["bytes", new Uint8Array([0, 1, 255])],
		["no bytes", new Uint8Array([])],
	]

	it.each(KEY_VALUES)("reads %s back as itself, and carries it", (_label, value) => {
		expect(roundTrip(value)).toEqual(value)
		expect(carried(value, decodeValue)).toBe(true)
	})

	it("reads a Buffer, as drizzle's blob buffer mode reads one, back as its bytes", () => {
		expect(roundTrip(Buffer.from([2, 3]))).toEqual(new Uint8Array([2, 3]))
		expect(carried(Buffer.from([2, 3]), decodeValue)).toBe(true)
	})

	it("reads a reference back as itself", () => {
		expect(carried(new CursorRef("ab", 9), decodeValue)).toBe(true)
	})

	it.each([
		["a JSON object", { n: 1 }],
		["an object shaped like a tag", { $num: "Infinity" }],
		["an array", [1, 2]],
		["a function", () => 1],
		["a symbol", Symbol("k")],
		["undefined", undefined],
		["a bigint past 20 digits", 10n ** 25n],
	])("carries no %s", (_label, value) => {
		expect(carried(value, decodeValue)).toBe(false)
	})

	it("carries an id as decodeId reads one: a string, a finite number or a bigint, never a boolean or a time", () => {
		for (const id of ["a", 0, 7n]) expect(carried(id, decodeId), String(id)).toBe(true)
		for (const id of [true, new Date(0), Number.NaN]) expect(carried(id, decodeId), String(id)).toBe(false)
	})

	it.each([
		["a bytes tag that is no base64url", { $bytes: "a+b" }],
		["a bytes tag that is not a string", { $bytes: 1 }],
	])("reads no value from %s", (_label, value) => {
		expect(decodeValue(value)).toBeUndefined()
	})
})

/* AB4-7 of area B: a SQLite REAL goes in the cursor as the text SQLite reads back as it, flagged `r` */
describe("a REAL's text in the cursor (AB4-7 of area B; sibling: the values the codec reads back)", () => {
	it("reads back as the same text, on the wire or as a RealText, and as no other text or number", () => {
		const real = new RealText("1.5")
		expect(sameValue(real, "1.5")).toBe(true)
		expect(sameValue(real, new RealText("1.5"))).toBe(true)
		expect(sameValue(real, new RealText("1.50"))).toBe(false)
		expect(sameValue(real, 1.5)).toBe(false)
	})

	it("opens a flagged value as its RealText only where it is text SQLite prints a REAL in", () => {
		for (const text of ["7", "-0.1", "1e-300", "1.0000000000000002e+300", "9e999"])
			expect(realTextOf(text), text).toEqual(new RealText(text))
		for (const value of [1.5, null, "", "1.", ".5", "0x10", "Infinity", "1e", " 1"])
			expect(realTextOf(value), String(value)).toBeUndefined()
	})
})
