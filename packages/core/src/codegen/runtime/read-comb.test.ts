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

/* F60: a bound JSON cannot carry would reach the snapshot as null and drop without a word */
describe("constraintsOf: a number that is no finite number", () => {
	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"refuses %s, naming the column and the key",
		(max) => {
			expect(() => constraintsOf({ max }, "t.c")).toThrow(
				`t.c: the constraint max is ${max}, no finite number; a bound read from the environment is NaN in codegen's child, which has none of it`,
			)
		},
	)
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

	/* F9 of the 0.14.1 review: a misspelt key would leave its part of the machine unread */
	it("refuses a key no state machine has, naming the column and the key", () => {
		expect(() => statesOf({ inital: "a" }, "t.c")).toThrow(
			"t.c: its state machine has inital, which is none of initial, terminal, transitions and values",
		)
	})
})
