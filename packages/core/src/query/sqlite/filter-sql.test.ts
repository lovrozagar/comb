import type { SQL } from "drizzle-orm"
import { SQLiteDialect } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { CombError } from "../../error.ts"
import { parseFilter } from "../filter.ts"
import { buildConditionSQL, buildFilterSQL } from "./filter-sql.ts"
import type { FilterCondition, FilterGroup } from "../types.ts"

const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()
const compile = (built: SQL) => dialect.sqlToQuery(built)

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

	it("matches nothing for in with an empty array, everything for nin", () => {
		for (const [operator, text] of [
			["in", "0"],
			["nin", "1"],
		] as const) {
			expect(compile(buildConditionSQL({ field: "role", operator, value: [] }, config) as SQL).sql).toBe(text)
		}
	})

	it("builds nin condition", () => {
		const condition: FilterCondition = {
			field: "role",
			operator: "nin",
			value: ["guest"],
		}
		expect(buildConditionSQL(condition, config)).toBeTruthy()
	})
})

describe("buildConditionSQL — patterns and null checks", () => {
	it("builds like condition", () => {
		const condition: FilterCondition = { field: "name", operator: "like", value: "*test*" }
		expect(buildConditionSQL(condition, config)).toBeTruthy()
	})

	it("lowers name.like.% to GLOB, where % is literal", () => {
		const ast = parseFilter("name.like.%")
		const condition = ast?.root.conditions[0]
		expect(condition?.value).toBe("%")
		const built = buildConditionSQL(condition as FilterCondition, config)
		expect(built).toBeTruthy()
		const { params, sql } = dialect.sqlToQuery(built as SQL)
		expect(params).toEqual(["%"])
		expect(sql.toLowerCase()).toContain("glob")
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

	it("throws when one condition of several has an unknown field, instead of keeping the rest", () => {
		const group: FilterGroup = {
			conditions: [
				{ field: "unknown", operator: "eq", value: "x" },
				{ field: "status", operator: "eq", value: "active" },
			],
			logic: "and",
			subgroups: [],
		}
		expect(() => buildFilterSQL(group, config)).toThrow(CombError)
	})
})

/** A group of one condition */
const one = (field: string, operator = "eq", value: unknown = "x"): FilterGroup => ({
	conditions: [{ field, operator, value } as FilterCondition],
	logic: "and",
	subgroups: [],
})

describe("buildFilterSQL — fields it cannot map (Q-L3, Q-H3)", () => {
	it("does not map a field through the prototype chain", () => {
		expect(buildConditionSQL({ field: "toString", operator: "eq", value: 1 }, config)).toBeNull()
		expect(buildConditionSQL({ field: "constructor", operator: "is", value: null }, config)).toBeNull()
		expect(
			buildConditionSQL({ field: "status", operator: "regex", value: ".*" } as unknown as FilterCondition, config),
		).toBeNull()
	})

	it("throws filter_not_wired for a condition it cannot express, instead of dropping it", () => {
		expect(() => buildFilterSQL(one("unknown"), config)).toThrow(CombError)
		expect(() => buildFilterSQL(one("toString"), config)).toThrow(CombError)
		expect(() => buildFilterSQL(one("status", "is", "maybe"), config)).toThrow(CombError)
	})

	it("skips an empty subgroup and keeps the rest", () => {
		const group: FilterGroup = { ...one("status"), subgroups: [{ conditions: [], logic: "or", subgroups: [] }] }
		expect(compile(buildFilterSQL(group, config) as SQL).params).toEqual(["x"])
	})

	it("lowers is.true and is.false to an equality", () => {
		const built = buildConditionSQL({ field: "status", operator: "is", value: true }, config)
		expect(built && compile(built).params).toEqual([true])
	})
})

describe("buildConditionSQL — identifiers (plan 3.9)", () => {
	it("quotes the alias and the column, so neither is read as SQL", () => {
		const built = buildConditionSQL(
			{ field: "name", operator: "eq", value: "x" },
			{ columnMap: { name: 'na"me; --' }, tableAlias: "u" },
		)
		expect(built && compile(built).sql).toBe('"u"."na""me; --" = ?')
	})
})

/** A group with nothing in it */
const empty = (logic: "and" | "or"): FilterGroup => ({ conditions: [], logic, subgroups: [] })

describe("buildFilterSQL on an empty group (Q-D1)", () => {
	it("reads it as the identity of its logic: and() everything, or() nothing", () => {
		expect(dialect.sqlToQuery(buildFilterSQL(empty("and"), config)).sql).toBe("1")
		expect(dialect.sqlToQuery(buildFilterSQL({ ...empty("and"), subgroups: [empty("or")] }, config)).sql).toBe("(0)")
	})
})
