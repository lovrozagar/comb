import { describe, expect, it } from "vitest"
import { decodeCursor } from "../../../src/query/cursor.ts"
import { drizzle } from "../../../src/query/drizzle.ts"
import type { FilterAST } from "../../../src/query/types.ts"

describe("drizzle.countExtra", () => {
	it("returns object with _total sql field", () => {
		const result = drizzle.countExtra()
		expect(result._total).toBeDefined()
	})
})

describe("drizzle.filterValue", () => {
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
		expect(drizzle.filterValue(ast, "status")).toBe("active")
	})

	it("returns undefined for missing field", () => {
		expect(drizzle.filterValue(ast, "unknown")).toBeUndefined()
	})

	it("returns undefined for null ast", () => {
		expect(drizzle.filterValue(null, "status")).toBeUndefined()
	})

	it("extracts array value", () => {
		expect(drizzle.filterValue(ast, "role")).toEqual(["admin", "user"])
	})
})

describe("drizzle.filterValues", () => {
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
		const result = drizzle.filterValues(ast, ["status", "role"])
		expect(result).toEqual({ role: "admin", status: "active" })
	})

	it("returns partial result for missing fields", () => {
		const result = drizzle.filterValues(ast, ["status", "missing"])
		expect(result).toEqual({ status: "active" })
	})

	it("returns empty for null ast", () => {
		expect(drizzle.filterValues(null, ["status"])).toEqual({})
	})
})

describe("drizzle.listOptions", () => {
	it("returns limit + 1", () => {
		const result = drizzle.listOptions({
			limit: 20,
			sortOrderBy: { createdAt: "desc" },
		})
		expect(result.limit).toBe(21)
	})

	it("returns offset 0 when cursor present", () => {
		const result = drizzle.listOptions({
			cursor: "some-cursor",
			limit: 20,
			sortOrderBy: { createdAt: "desc" },
		})
		expect(result.offset).toBe(0)
	})

	it("returns offset = (page - 1) * limit for page-based", () => {
		const result = drizzle.listOptions({
			limit: 20,
			page: 3,
			sortOrderBy: { createdAt: "desc" },
		})
		expect(result.offset).toBe(40)
	})

	it("defaults page to 1 when no cursor or page", () => {
		const result = drizzle.listOptions({
			limit: 10,
			sortOrderBy: { name: "asc" },
		})
		expect(result.offset).toBe(0)
	})

	it("passes through sortOrderBy", () => {
		const sortOrderBy = { createdAt: "desc" as const, name: "asc" as const }
		const result = drizzle.listOptions({
			limit: 10,
			sortOrderBy,
		})
		expect(result.sortOrderBy).toEqual(sortOrderBy)
	})
})

describe("drizzle.paginate", () => {
	const defaultQuery = {
		limit: 5,
		parsedSort: [{ direction: "desc" as const, field: "createdAt" }],
	}

	it("returns paginated result with hasMore=false", () => {
		const items = [
			{ _total: 2, id: "1" },
			{ _total: 2, id: "2" },
		]
		const [resultItems, pagination] = drizzle.paginate(items, { ...defaultQuery, limit: 5 })

		expect(pagination.count).toBe(2)
		expect(pagination.hasMore).toBe(false)
		expect(resultItems).toHaveLength(2)
		expect(pagination.limit).toBe(5)
		expect(pagination.page).toBe(1)
	})

	it("detects hasMore when items exceed limit", () => {
		const items = [
			{ _total: 10, id: "1" },
			{ _total: 10, id: "2" },
			{ _total: 10, id: "3" },
		]
		const [resultItems, pagination] = drizzle.paginate(items, { ...defaultQuery, limit: 2 })

		expect(pagination.hasMore).toBe(true)
		expect(resultItems).toHaveLength(2)
	})

	it("uses _total from first item", () => {
		const items = [{ _total: 42, id: "1" }]
		const [, pagination] = drizzle.paginate(items, { ...defaultQuery, limit: 10 })

		expect(pagination.count).toBe(42)
	})

	it("returns 0 count for empty results", () => {
		const [resultItems, pagination] = drizzle.paginate([], { ...defaultQuery, limit: 10 })

		expect(pagination.count).toBe(0)
		expect(pagination.hasMore).toBe(false)
		expect(resultItems).toHaveLength(0)
	})

	it("respects page parameter", () => {
		const items = [{ _total: 100, id: "1" }]
		const [, pagination] = drizzle.paginate(items, { ...defaultQuery, limit: 10, page: 3 })

		expect(pagination.page).toBe(3)
	})

	it("defaults page to 1", () => {
		const [, pagination] = drizzle.paginate([], { ...defaultQuery, limit: 10 })
		expect(pagination.page).toBe(1)
	})

	it("populates nextCursor when hasMore and items have id", () => {
		const items = [
			{ _total: 50, createdAt: "2024-01-03", id: "c" },
			{ _total: 50, createdAt: "2024-01-02", id: "b" },
			{ _total: 50, createdAt: "2024-01-01", id: "a" },
		]
		const [, pagination] = drizzle.paginate(items, {
			limit: 2,
			parsedSort: [{ direction: "desc", field: "createdAt" }],
		})

		expect(pagination.hasMore).toBe(true)
		expect(pagination.nextCursor).toBeTruthy()

		const decoded = decodeCursor(pagination.nextCursor)
		expect(decoded).toEqual({ c: "2024-01-02", i: "b" })
	})

	it("returns page=null when cursor is present in query", () => {
		const items = [{ _total: 5, id: "1" }]
		const [, pagination] = drizzle.paginate(items, {
			cursor: "some-cursor",
			limit: 10,
			parsedSort: [{ direction: "desc", field: "createdAt" }],
		})

		expect(pagination.page).toBeNull()
	})

	it("builds nextCursor even for page-only when hasMore", () => {
		const items = [
			{ _total: 50, createdAt: "2024-03-01", id: "x" },
			{ _total: 50, createdAt: "2024-02-01", id: "y" },
			{ _total: 50, createdAt: "2024-01-01", id: "z" },
		]
		const [, pagination] = drizzle.paginate(items, {
			limit: 2,
			page: 1,
			parsedSort: [{ direction: "desc", field: "createdAt" }],
		})

		expect(pagination.hasMore).toBe(true)
		expect(pagination.page).toBe(1)
		expect(pagination.nextCursor).toBeTruthy()
	})

	it("keeps nextCursor null when items lack id", () => {
		const items = [
			{ _total: 10, name: "a" },
			{ _total: 10, name: "b" },
			{ _total: 10, name: "c" },
		]
		const [, pagination] = drizzle.paginate(items, {
			limit: 2,
			parsedSort: [{ direction: "desc", field: "name" }],
		})

		expect(pagination.hasMore).toBe(true)
		expect(pagination.nextCursor).toBeNull()
	})

	it("returns nextCursor null and hasMore false for empty results", () => {
		const [, pagination] = drizzle.paginate([], {
			limit: 10,
			parsedSort: [{ direction: "desc", field: "createdAt" }],
		})

		expect(pagination.nextCursor).toBeNull()
		expect(pagination.hasMore).toBe(false)
	})
})
