import { describe, expect, it } from "vitest"
import { queryHelpers } from "./drizzle.ts"
import type { FilterAST } from "./types.ts"

describe("queryHelpers.filterValue", () => {
	const ast: FilterAST = {
		root: {
			conditions: [
				{ field: "status", operator: "eq", value: "active" },
				{ field: "role", operator: "in", value: ["admin", "user"] },
			],
			logic: "and",
			subgroups: [],
		},
	}

	it("extracts single filter value by field name", () => {
		expect(queryHelpers.filterValue(ast, "status")).toBe("active")
	})

	it("returns undefined for missing field", () => {
		expect(queryHelpers.filterValue(ast, "unknown")).toBeUndefined()
	})

	it("returns undefined for null ast", () => {
		expect(queryHelpers.filterValue(null, "status")).toBeUndefined()
	})

	it("extracts array value", () => {
		expect(queryHelpers.filterValue(ast, "role")).toEqual(["admin", "user"])
	})
})

describe("queryHelpers.filterValues", () => {
	const ast: FilterAST = {
		root: {
			conditions: [
				{ field: "status", operator: "eq", value: "active" },
				{ field: "role", operator: "eq", value: "admin" },
			],
			logic: "and",
			subgroups: [],
		},
	}

	it("extracts multiple values at once", () => {
		const result = queryHelpers.filterValues(ast, ["status", "role"])
		expect(result).toEqual({ role: "admin", status: "active" })
	})

	it("returns partial result for missing fields", () => {
		const result = queryHelpers.filterValues(ast, ["status", "missing"])
		expect(result).toEqual({ status: "active" })
	})

	it("returns empty for null ast", () => {
		expect(queryHelpers.filterValues(null, ["status"])).toEqual({})
	})
})
