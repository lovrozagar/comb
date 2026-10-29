/**
 * S4 of the 0.12 consumers review: the number rule exported, and a field map a dynamic-column
 * builder can type a user table with: operators of its own, contains, ordered text, ISO dates
 */
import { describe, expect, it } from "vitest"
import { parseFilterNumber, validateFilter } from "./filter-validate.ts"
import type { FilterField } from "./filter-validate.ts"
import { IsoInstant } from "./iso-date.ts"

/** The one condition's value a valid filter types, or its errors */
function typed(filter: string, fields: Record<string, FilterField>): unknown {
	const result = validateFilter(filter, fields)
	if (!result?.valid) return { errors: result?.errors }
	return result.ast.root.conditions[0]?.value
}

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

describe("validateFilter: a field's own operators", () => {
	it("takes contains on a field that lists it, the value typed as one of the field's type", () => {
		expect(typed("tags.contains.red", { tags: { operators: ["contains", "is"], type: "string" } })).toBe("red")
		expect(typed("scores.contains.7", { scores: { operators: ["contains"], type: "number" } })).toBe(7)
		expect(typed("scores.contains.0x10", { scores: { operators: ["contains"], type: "number" } })).toEqual({
			errors: ["Invalid value for 'scores': expects a number, got '0x10'"],
		})
	})

	it("refuses contains on a field that does not list it, and an operator the list leaves out", () => {
		expect(typed("tags.contains.red", { tags: "string" })).toEqual({
			errors: ["Invalid operator 'contains' for field 'tags' (type: string)"],
		})
		expect(typed("tags.eq.red", { tags: { operators: ["contains"], type: "string" } })).toEqual({
			errors: ["Invalid operator 'eq' for field 'tags' (type: string)"],
		})
	})

	it("orders a string field that lists the comparisons, and not one that does not", () => {
		const name = { operators: ["eq", "gt", "gte", "lt", "lte"], type: "string" } as const
		expect(typed("name.gt.m", { name })).toBe("m")
		expect(typed("name.lte.Zed", { name })).toBe("Zed")
		expect(typed("name.gt.m", { name: "string" })).toEqual({
			errors: ["Invalid operator 'gt' for field 'name' (type: string)"],
		})
	})

	it("types a spec with no operators as its type does", () => {
		expect(typed("amount.gt.5", { amount: { type: "number" } })).toBe(5)
		expect(typed("amount.like.5*", { amount: { type: "number" } })).toEqual({
			errors: ["Invalid operator 'like' for field 'amount' (type: number)"],
		})
	})

	it("throws a TypeError for a spec its type cannot take, naming the field, the operator and the type", () => {
		expect(() => validateFilter("amount.eq.1", { amount: { operators: ["like"], type: "number" } })).toThrow(
			new TypeError("validateFilter: field 'amount' lists operator 'like', which a number field cannot take"),
		)
		expect(() => validateFilter("ok.eq.1", { ok: { operators: ["in"], type: "boolean" } })).toThrow(
			new TypeError("validateFilter: field 'ok' lists operator 'in', which a boolean field cannot take"),
		)
		expect(() => validateFilter("at.eq.1", { at: { format: "iso", type: "number" } as never })).toThrow(
			new TypeError("validateFilter: field 'at' has format 'iso', which only a date field takes"),
		)
	})
})

describe("validateFilter: an ISO 8601 date field", () => {
	const due = { format: "iso", type: "date" } as const

	/* Q5 of the 0.14.1 review: one instant compares as one, however it is spelled */
	it("takes a date or a date-time, with Z or an offset, typed as the instant it names in toISOString()'s form", () => {
		/* U35: year 0 is a leap year in the proleptic Gregorian calendar ISO 8601 counts in */
		for (const [raw, instant] of [
			["0000-02-29", "0000-02-29T00:00:00.000Z"],
			["0099-12-31T23:59Z", "0099-12-31T23:59:00.000Z"],
			["2000-02-29", "2000-02-29T00:00:00.000Z"],
			["2024-01-01T10:20Z", "2024-01-01T10:20:00.000Z"],
			["2024-01-01T10:20:30.123456789Z", "2024-01-01T10:20:30.123Z"],
			["2024-01-01T00:00+14:00", "2023-12-31T10:00:00.000Z"],
			["2024-01-01T00:00:05.5-03:30", "2024-01-01T03:30:05.500Z"],
		])
			expect(String(typed(`due.gte.${raw}`, { due })), raw).toBe(instant)
		expect(typed("due.is.null", { due })).toBeNull()
	})
})

describe("validateFilter: an ISO 8601 date field, refused or kept", () => {
	const due = { format: "iso", type: "date" } as const

	it("refuses a day the calendar has not, a bad time, and epoch milliseconds", () => {
		for (const raw of [
			"2025-02-29",
			"1900-02-29",
			"0100-02-29",
			"2024-02-30",
			"2024-13-01",
			"2024-00-10",
			"2024-01-01T24:00Z",
			"2024-01-01T10:60Z",
		])
			expect(typed(`due.eq.${raw}`, { due })).toEqual({
				errors: [`Invalid value for 'due': expects an ISO 8601 date or date-time, got '${raw}'`],
			})
		for (const raw of ["1700000000000", "2024-1-01", "2024-01-01T10:20", "2024-01-01T10:20+1400", "2024-01-01 10:20Z"])
			expect(typed(`due.eq.${raw}`, { due })).toMatchObject({ errors: [expect.stringContaining("ISO 8601")] })
	})

	it("keeps a date field with no format on epoch milliseconds", () => {
		expect(typed("due.eq.1700000000000", { due: "date" })).toBe(1_700_000_000_000)
		expect(typed("due.eq.2024-02-29", { due: { type: "date" } })).toMatchObject({
			errors: [expect.stringContaining("epoch milliseconds")],
		})
	})
})

/* Q4 of r17: the instant carries its milliseconds, and stays in the years toISOString writes in four digits */
describe("validateFilter: an ISO 8601 date field's instant", () => {
	const due = { format: "iso", type: "date" } as const

	/* Q4 of r17: the instant carries its milliseconds, so no lowering reads its text back */
	it("types the value as an IsoInstant, its epoch milliseconds and its text, which JSON writes as the text", () => {
		const value = typed("due.gte.2024-01-01T01:00+01:00", { due })
		expect(value).toBeInstanceOf(IsoInstant)
		expect(value).toMatchObject({ ms: Date.UTC(2024, 0, 1), text: "2024-01-01T00:00:00.000Z" })
		expect(JSON.stringify({ value })).toBe('{"value":"2024-01-01T00:00:00.000Z"}')
	})

	/* Q4 of r17: toISOString writes a year past 9999 or before 0000 in its expanded form, which sorts wrong as text */
	it("refuses an instant its offset moves out of the years 0000 to 9999", () => {
		for (const raw of ["0000-01-01T00:00+01:00", "9999-12-31T23:30-01:00"])
			expect(typed(`due.lt.${raw}`, { due })).toEqual({
				errors: [`Invalid value for 'due': expects an instant in the years 0000 to 9999, got '${raw}'`],
			})
		expect(String(typed("due.lt.0000-01-01T02:00+01:00", { due }))).toBe("0000-01-01T01:00:00.000Z")
	})
})
