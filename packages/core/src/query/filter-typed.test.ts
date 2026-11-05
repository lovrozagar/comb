import { describe, expect, it } from "vitest"
import { type CheckedField, parseFilterNumber, typedValue } from "./filter-typed.ts"
import { validateFilter } from "./filter-validate.ts"
import type { FieldType, FilterOperator } from "./types.ts"

/** The least normal double, 2^-1022 */
const MIN_NORMAL = 2 ** -1022

describe("parseFilterNumber", () => {
	it("refuses the spellings Number() takes that comb does not, and an integer past 2^53 - 1", () => {
		for (const raw of ["0x4d2", "0b10011010010", "0o2322", "", " 1", "1_000", "Infinity", "1e999"])
			expect(parseFilterNumber(raw)).toEqual({ error: `expects a number, got '${raw}'` })
		expect(parseFilterNumber("9007199254740993")).toEqual({
			error: "expects a number within ±9007199254740991, got '9007199254740993'",
		})
		expect(parseFilterNumber("1234")).toEqual({ value: 1234 })
		expect(parseFilterNumber("-1.5e3")).toEqual({ value: -1500 })
	})
})

/* QL12 of r22b: an underflowing number read as 0, so `n.lt.1e-400` missed the rows holding 0 */
describe("parseFilterNumber on a value too small for a double (QL12 of r22b; sibling: overflow's 1e999)", () => {
	const tooSmall = (raw: string) => ({
		error: `expects a number of magnitude 0 or at least ${MIN_NORMAL}, got '${raw}'`,
	})

	it.each(["1e-400", "-1e-400", "0.000001e-320", "5e-324", "2e-308"])(
		"refuses %s, which reads as 0 or a subnormal",
		(raw) => {
			expect(parseFilterNumber(raw)).toEqual(tooSmall(raw))
			expect(validateFilter(`n.lt.${raw}`, { n: "number" })?.valid).toBe(false)
		},
	)

	it.each([
		["0", 0],
		["0.0e-400", 0],
		["-0", -0],
		["2.2250738585072014e-308", MIN_NORMAL],
		["1e-300", 1e-300],
	])("takes %s, a zero or a normal double", (raw, value) => {
		expect(parseFilterNumber(raw)).toEqual({ value })
	})
})

/** A `type` field, ISO-formatted when the type is "iso date" */
const field = (type: FieldType | "iso date"): CheckedField =>
	type === "iso date" ? { format: "iso", operators: [], type: "date" } : { format: undefined, operators: [], type }
const typed = (type: FieldType | "iso date", operator: FilterOperator, value: unknown) =>
	typedValue(field(type), { field: "f", operator, value })

describe("typedValue", () => {
	it("types a scalar as its field declares", () => {
		expect(typed("number", "eq", "-1.5e3")).toEqual({ value: -1500 })
		expect(typed("date", "gt", "1700000000000")).toEqual({ value: 1700000000000 })
		expect(typed("boolean", "eq", "false")).toEqual({ value: false })
		expect(typed("string", "eq", "10")).toEqual({ value: "10" })
		expect(typed("iso date", "lt", "2024-01-02")).toEqual({ value: expect.objectContaining({ ms: 1704153600000 }) })
	})

	it("refuses a scalar its field cannot hold", () => {
		expect(typed("date", "gt", "1.5")).toEqual({ error: "expects epoch milliseconds, got '1.5'" })
		expect(typed("date", "gt", "8640000000000001")).toEqual({
			error: "expects epoch milliseconds within ±8640000000000000, got '8640000000000001'",
		})
		expect(typed("boolean", "eq", "yes")).toEqual({ error: "expects true or false, got 'yes'" })
		expect(typed("iso date", "lt", "soon")).toEqual({ error: "expects an ISO 8601 date or date-time, got 'soon'" })
		expect(typed("iso date", "lt", "9999-12-31T23:00:00-05:00")).toEqual({
			error: "expects an instant in the years 0000 to 9999, got '9999-12-31T23:00:00-05:00'",
		})
	})

	it("types each item of a list, and refuses the list on its first bad item", () => {
		expect(typed("number", "in", ["1", "2"])).toEqual({ value: [1, 2] })
		expect(typed("number", "nin", ["1", "x", "y"])).toEqual({ error: "expects a number, got 'x'" })
		expect(typed("number", "in", "1")).toEqual({ error: "in and nin take a list, as in.(a,b)" })
	})

	it("takes null and notnull after is on every field, true and false on a boolean one", () => {
		expect(typed("number", "is", null)).toEqual({ value: null })
		expect(typed("string", "is", "NOTNULL")).toEqual({ value: "notnull" })
		expect(typed("boolean", "is", "True")).toEqual({ value: true })
		expect(typed("string", "is", "true")).toEqual({ error: "is takes null or notnull, got 'true'" })
		expect(typed("boolean", "is", "maybe")).toEqual({ error: "is takes null, notnull, true or false, got 'maybe'" })
	})
})
