import { describe, expect, it } from "vitest"
import { constraintsOf, statesOf, STRING_LIST } from "./read-comb.ts"

describe("STRING_LIST", () => {
	it("holds an array of strings alone", () => {
		expect(STRING_LIST(["a", "b"])).toBe(true)
		expect(STRING_LIST([])).toBe(true)
		expect(STRING_LIST(["a", 1])).toBe(false)
		expect(STRING_LIST("a")).toBe(false)
	})
})

describe("constraintsOf", () => {
	it("keeps every primitive, drops an undefined one, and reads none as empty", () => {
		expect(constraintsOf({ max: 3, pattern: "/a/", private: true, trim: undefined }, "t.c")).toEqual({
			max: 3,
			pattern: "/a/",
			private: true,
		})
		expect(constraintsOf(undefined, "t.c")).toEqual({})
	})

	it("refuses any other value, naming the column and the constraint", () => {
		expect(() => constraintsOf({ max: {} }, "t.c")).toThrow(
			"t.c: the constraint max is a object; comb reads a boolean, a number or a string",
		)
	})
})

describe("statesOf", () => {
	it("reads no machine as null, and each part it leaves out as null", () => {
		expect(statesOf(undefined, "t.c")).toBeNull()
		expect(statesOf({}, "t.c")).toEqual({ initial: null, terminal: null, transitions: null })
		expect(statesOf({ initial: "a", terminal: ["b"], transitions: { a: ["b"] } }, "t.c")).toEqual({
			initial: "a",
			terminal: ["b"],
			transitions: { a: ["b"] },
		})
	})

	it("refuses a machine of another shape, naming the column", () => {
		for (const raw of [{ initial: 1 }, { terminal: "b" }, { transitions: { a: "b" } }])
			expect(() => statesOf(raw, "t.c")).toThrow("t.c: its state machine is not")
	})
})
