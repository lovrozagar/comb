import { describe, expect, it } from "vitest"
import { OPERATORS_BY_TYPE, validateFilter } from "./filter-validate.ts"

/** `a.in.(0,…,n-1)` */
const list = (n: number) => `a.in.(${Array.from({ length: n }, (_, i) => i).join(",")})`

describe("validateFilter", () => {
	it("returns null for empty filter", () => {
		expect(validateFilter("", {})).toBeNull()
		expect(validateFilter(null, {})).toBeNull()
	})

	it("validates known fields", () => {
		const result = validateFilter("status.eq.active", { status: "enum" })
		expect(result?.valid).toBe(true)
	})

	it("rejects unknown fields", () => {
		const result = validateFilter("unknown.eq.x", { status: "enum" })
		expect(result?.valid).toBe(false)
		if (result && !result.valid) {
			expect(result.errors[0]).toContain("Unknown filter field")
		}
	})

	it("rejects invalid operators for field type", () => {
		const result = validateFilter("active.like.%test%", { active: "boolean" })
		expect(result?.valid).toBe(false)
	})

	it("allows every operator its type lists, given a value of that type", () => {
		const sample = { boolean: "true", date: "1700000000000", enum: "val", number: "7", string: "val" } as const
		for (const [type, ops] of Object.entries(OPERATORS_BY_TYPE) as Array<[keyof typeof sample, readonly string[]]>) {
			for (const op of ops) {
				const value =
					op === "in" || op === "nin" ? `(${sample[type]},${sample[type]})` : op === "is" ? "null" : sample[type]
				expect(validateFilter(`f.${op}.${value}`, { f: type })?.valid).toBe(true)
			}
		}
	})

	it("validates subgroups", () => {
		const result = validateFilter("or(bad.eq.x)", { status: "enum" })
		expect(result?.valid).toBe(false)
	})
})

describe("validateFilter — diagnostics", () => {
	it("reports invalid syntax rather than throwing", () => {
		const result = validateFilter("status", { status: "enum" })
		expect(result?.valid).toBe(false)
		if (result && !result.valid) expect(result.errors[0]).toContain("Invalid filter syntax")
	})

	it("reports a field absent from the allowed set", () => {
		const result = validateFilter("secret.eq.x", { status: "enum" })
		expect(result?.valid).toBe(false)
		if (result && !result.valid) expect(result.errors.join(" ")).toContain("Unknown filter field")
	})

	it("reports an operator the field's type does not support", () => {
		const result = validateFilter("active.like.x", { active: "boolean" })
		expect(result?.valid).toBe(false)
		if (result && !result.valid) expect(result.errors.join(" ")).toContain("Invalid operator")
	})

	it("rejects contains on every field type: comb runs no contains, its callers do", () => {
		for (const type of ["boolean", "date", "enum", "number", "string"] as const) {
			const result = validateFilter("tags.contains.red", { tags: type })
			expect(result?.valid).toBe(false)
		}
	})

	it("returns null for an absent filter rather than an empty result", () => {
		expect(validateFilter(null, { status: "enum" })).toBeNull()
		expect(validateFilter("   ", { status: "enum" })).toBeNull()
	})
})

describe("validateFilter — limits", () => {
	const fields = { a: "number", name: "string" } as const

	it("rejects more than 20 conditions by default", () => {
		const twenty = Array.from({ length: 20 }, (_, i) => `a.neq.${i}`).join(",")
		expect(validateFilter(twenty, fields)?.valid).toBe(true)
		const result = validateFilter(`${twenty},a.neq.99`, fields)
		expect(result?.valid).toBe(false)
		if (result && !result.valid) expect(result.errors.join(";")).toContain("max 20")
	})

	it("rejects nesting deeper than 3 groups by default", () => {
		expect(validateFilter("or(and(or(a.eq.1,a.eq.2),a.eq.3),a.eq.4)", fields)?.valid).toBe(true)
		const result = validateFilter("or(and(or(and(a.eq.1,a.eq.2),a.eq.3),a.eq.4),a.eq.5)", fields)
		expect(result?.valid).toBe(false)
		if (result && !result.valid) expect(result.errors.join(";")).toContain("max 3")
	})

	it("rejects in lists over 50 values, and filters binding over 60 values in all, by default (S-11)", () => {
		expect(validateFilter(list(50), fields)?.valid).toBe(true)
		expect(validateFilter(list(51), fields)).toEqual({
			errors: ["in/nin list too large for 'a': 51 (max 50)"],
			valid: false,
		})
		expect(validateFilter(`${list(50)},${list(10)}`, fields)?.valid).toBe(true)
		expect(validateFilter(`${list(50)},${list(11)}`, fields)).toEqual({
			errors: ["Filter binds too many values: 61 (max 60)"],
			valid: false,
		})
	})

	it("counts is.null as binding nothing and is.true as binding one value", () => {
		const nulls = Array.from({ length: 20 }, () => "a.is.null").join(",")
		expect(validateFilter(nulls, fields, { maxValues: 0 })?.valid).toBe(true)
		expect(validateFilter("b.is.true", { b: "boolean" }, { maxValues: 0 })?.valid).toBe(false)
	})

	it("accepts custom limits", () => {
		const result = validateFilter("a.eq.1,a.eq.2", fields, { maxConditions: 1 })
		expect(result?.valid).toBe(false)
	})
})

describe("validateFilter — values typed as their field declares (Q-M4, Q-H2)", () => {
	const fields = { at: "date", n: "number", on: "boolean", s: "string" } as const
	const conditions = (filter: string) => {
		const result = validateFilter(filter, fields)
		return result?.valid ? result.ast.root.conditions.map(({ value }) => value) : result?.errors
	}

	it("types numbers, epoch dates and booleans, and leaves strings alone", () => {
		expect(conditions("n.eq.-1.5e2,at.gt.1700000000000,on.eq.false,s.eq.007")).toEqual([
			-150,
			1700000000000,
			false,
			"007",
		])
		expect(conditions("n.in.(1,2.5)")).toEqual([[1, 2.5]])
	})

	it("types is as null, notnull, or a boolean on a boolean field", () => {
		expect(conditions("s.is.null,s.is.NotNull,on.is.TRUE,on.is.false")).toEqual([null, "notnull", true, false])
	})

	it("says why a value does not fit", () => {
		expect(conditions("n.lt.abc")).toEqual(["Invalid value for 'n': expects a number, got 'abc'"])
		expect(conditions("at.lt.2024-01-01")).toEqual([
			"Invalid value for 'at': expects epoch milliseconds, got '2024-01-01'",
		])
		expect(conditions("on.eq.1")).toEqual(["Invalid value for 'on': expects true or false, got '1'"])
		expect(conditions("n.in.(1,x)")).toEqual(["Invalid value for 'n': expects a number, got 'x'"])
		expect(conditions("on.is.maybe")).toEqual([
			"Invalid value for 'on': is takes null, notnull, true or false, got 'maybe'",
		])
		expect(conditions("s.is.true")).toEqual(["Invalid value for 's': is takes null or notnull, got 'true'"])
	})

	it("does not take a field from the prototype chain (Q-M2)", () => {
		expect(conditions("constructor.eq.x")).toEqual(["Unknown filter field: constructor"])
		expect(conditions("__proto__.eq.x")).toEqual(["Unknown filter field: __proto__"])
	})
})

describe("validateFilter — in and nin take a list (S-M2)", () => {
	it("refuses a bare value instead of passing a scalar the driver rejects", () => {
		expect(validateFilter("a.in.5", { a: "number" })).toEqual({
			errors: ["Invalid value for 'a': in and nin take a list, as in.(a,b)"],
			valid: false,
		})
		expect(validateFilter("a.nin.x", { a: "string" })?.valid).toBe(false)
		expect(validateFilter("a.in.(5)", { a: "number" })?.valid).toBe(true)
	})
})
