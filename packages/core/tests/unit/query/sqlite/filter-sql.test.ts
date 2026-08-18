import type { SQL } from "drizzle-orm"
import { SQLiteDialect } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { parseFilter } from "../../../../src/query/filter.ts"
import { buildConditionSQL, buildFilterSQL } from "../../../../src/query/sqlite/filter-sql.ts"
import type { FilterCondition, FilterGroup } from "../../../../src/query/types.ts"

const config = {
	columnMap: { name: "name", role: "role", status: "status" },
	tableAlias: "u",
}

describe("buildConditionSQL", () => {
	it("builds eq condition", () => {
		const condition: FilterCondition = { field: "status", operator: "eq", value: "active" }
		const result = buildConditionSQL(condition, config)
		expect(result).toBeTruthy()
	})

	it("builds ne/neq condition", () => {
		const ne: FilterCondition = { field: "status", operator: "ne", value: "deleted" }
		const neq: FilterCondition = { field: "status", operator: "neq", value: "deleted" }
		expect(buildConditionSQL(ne, config)).toBeTruthy()
		expect(buildConditionSQL(neq, config)).toBeTruthy()
	})

	it("builds comparison operators", () => {
		for (const op of ["gt", "gte", "lt", "lte"] as const) {
			const condition: FilterCondition = { field: "name", operator: op, value: "x" }
			expect(buildConditionSQL(condition, config)).toBeTruthy()
		}
	})

	it("builds in condition with array", () => {
		const condition: FilterCondition = {
			field: "role",
			operator: "in",
			value: ["admin", "user"],
		}
		expect(buildConditionSQL(condition, config)).toBeTruthy()
	})

	it("returns null for in with empty array", () => {
		const condition: FilterCondition = { field: "role", operator: "in", value: [] }
		expect(buildConditionSQL(condition, config)).toBeNull()
	})

	it("builds nin condition", () => {
		const condition: FilterCondition = {
			field: "role",
			operator: "nin",
			value: ["guest"],
		}
		expect(buildConditionSQL(condition, config)).toBeTruthy()
	})

	it("builds like condition", () => {
		const condition: FilterCondition = { field: "name", operator: "like", value: "*test*" }
		expect(buildConditionSQL(condition, config)).toBeTruthy()
	})

	it("escapes a literal % so name.like.% is not match-all", () => {
		const dialect = new (SQLiteDialect as unknown as new () => {
			sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
		})()
		const ast = parseFilter("name.like.%")
		const condition = ast?.root.conditions[0]
		expect(condition?.value).toBe("%")
		const built = buildConditionSQL(condition as FilterCondition, config)
		expect(built).toBeTruthy()
		const { params, sql } = dialect.sqlToQuery(built as SQL)
		expect(params).toEqual(["\\%"])
		expect(sql.toLowerCase()).toContain("escape")
	})

	it("builds ilike condition", () => {
		const condition: FilterCondition = { field: "name", operator: "ilike", value: "%test%" }
		expect(buildConditionSQL(condition, config)).toBeTruthy()
	})

	it("builds is null condition", () => {
		const condition: FilterCondition = { field: "status", operator: "is", value: null }
		expect(buildConditionSQL(condition, config)).toBeTruthy()
	})

	it("builds is notnull condition", () => {
		const condition: FilterCondition = { field: "status", operator: "is", value: "notnull" }
		expect(buildConditionSQL(condition, config)).toBeTruthy()
	})

	it("returns null for unknown field", () => {
		const condition: FilterCondition = { field: "unknown", operator: "eq", value: "x" }
		expect(buildConditionSQL(condition, config)).toBeNull()
	})
})

describe("buildFilterSQL", () => {
	it("builds AND group", () => {
		const group: FilterGroup = {
			conditions: [
				{ field: "status", operator: "eq", value: "active" },
				{ field: "role", operator: "eq", value: "admin" },
			],
			logic: "and",
			subgroups: [],
		}
		expect(buildFilterSQL(group, config)).toBeTruthy()
	})

	it("builds OR group", () => {
		const group: FilterGroup = {
			conditions: [
				{ field: "status", operator: "eq", value: "active" },
				{ field: "status", operator: "eq", value: "pending" },
			],
			logic: "or",
			subgroups: [],
		}
		expect(buildFilterSQL(group, config)).toBeTruthy()
	})

	it("returns null for empty group", () => {
		const group: FilterGroup = { conditions: [], logic: "and", subgroups: [] }
		expect(buildFilterSQL(group, config)).toBeNull()
	})

	it("handles nested subgroups", () => {
		const group: FilterGroup = {
			conditions: [{ field: "status", operator: "eq", value: "active" }],
			logic: "and",
			subgroups: [
				{
					conditions: [
						{ field: "role", operator: "eq", value: "admin" },
						{ field: "role", operator: "eq", value: "editor" },
					],
					logic: "or",
					subgroups: [],
				},
			],
		}
		expect(buildFilterSQL(group, config)).toBeTruthy()
	})

	it("skips conditions with unknown fields", () => {
		const group: FilterGroup = {
			conditions: [
				{ field: "unknown", operator: "eq", value: "x" },
				{ field: "status", operator: "eq", value: "active" },
			],
			logic: "and",
			subgroups: [],
		}
		expect(buildFilterSQL(group, config)).toBeTruthy()
	})
})
