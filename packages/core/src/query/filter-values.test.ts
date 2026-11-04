import { describe, expect, it } from "vitest"
import { queryHelpers } from "./drizzle.ts"
import { parseFilter } from "./filter-parse.ts"
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

	it("extracts an array value under the operator asked for", () => {
		expect(queryHelpers.filterValue(ast, "role", "in")).toEqual(["admin", "user"])
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

/* QL9 of r22b: a value read whatever its operator let `project_id.ne.p1` read as the project p1 */
describe("a filter value is what the filter holds every row to (QL9 of r22b; sibling: filterValues)", () => {
	it.each([
		["project_id.eq.p1", "p1"],
		["project_id.eq.p1,status.eq.open", "p1"],
		["project_id.eq.p1,or(status.eq.open,status.eq.done)", "p1"],
		["project_id.ne.p1", undefined],
		["project_id.like.p*", undefined],
		["project_id.in.(p1,p2)", undefined],
		["or(project_id.eq.p1,project_id.eq.p2)", undefined],
		["or(project_id.eq.p1,status.eq.open)", undefined],
		["project_id.eq.p1,project_id.eq.p2", undefined],
	])("reads %s's eq project_id as %j", (filter, value) => {
		expect(queryHelpers.filterValue(parseFilter(filter), "project_id")).toEqual(value)
		expect(queryHelpers.filterValues(parseFilter(filter), ["project_id"])).toEqual(
			value === undefined ? {} : { project_id: value },
		)
	})

	it("reads another operator when asked, the same way", () => {
		expect(queryHelpers.filterValue(parseFilter("project_id.in.(p1,p2)"), "project_id", "in")).toEqual(["p1", "p2"])
		expect(queryHelpers.filterValue(parseFilter("project_id.ne.p1"), "project_id", "ne")).toBe("p1")
		expect(queryHelpers.filterValues(parseFilter("a.gt.1,b.gt.2,b.lt.9"), ["a", "b"], "gt")).toEqual({ a: "1", b: "2" })
		expect(queryHelpers.filterValue(parseFilter("project_id.eq.p1"), "project_id", "ne")).toBeUndefined()
		/* ne and neq are one operator, however the filter spells it */
		expect(queryHelpers.filterValue(parseFilter("project_id.neq.p1"), "project_id", "ne")).toBe("p1")
		expect(queryHelpers.filterValue(parseFilter("project_id.ne.p1"), "project_id", "neq")).toBe("p1")
	})

	it("reads an OR root of one condition as an AND, and of two as nothing", () => {
		const condition = { field: "project_id", operator: "eq" as const, value: "p1" }
		const orOf = (conditions: (typeof condition)[]): FilterAST => ({ root: { conditions, logic: "or", subgroups: [] } })
		expect(queryHelpers.filterValue(orOf([condition]), "project_id")).toBe("p1")
		expect(queryHelpers.filterValue(orOf([condition, { ...condition, value: "p2" }]), "project_id")).toBeUndefined()
	})
})
