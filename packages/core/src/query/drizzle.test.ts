import { getTableColumns, type SQL, sql } from "drizzle-orm"
import { integer, SQLiteDialect, sqliteTable } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { CombError } from "../error.ts"
import { createCursor, decodeCursor } from "./cursor.ts"
import { queryHelpers } from "./drizzle.ts"
import { parseSelect } from "./fields.ts"
import type { FilterAST, SortField } from "./types.ts"

const post = sqliteTable("post", { created_at: integer("created_at"), id: integer("id").primaryKey() })
const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()

/** The pagination part of a built ListQueryResult */
const built = (type: "cursor" | "offset") => ({ limit: 21, meta: { limit: 20, page: 1, type }, offset: 0 })

describe("queryHelpers.countExtra", () => {
	it("selects the window count for an offset request and nothing for a cursor one", () => {
		expect(queryHelpers.countExtra({ cursor: "abc", limit: 20, parsedSort: [] })).toEqual({})
		const result = queryHelpers.countExtra({ cursor: undefined, limit: 20, parsedSort: [] })
		expect(result._total).toBeDefined()
	})

	it("takes only a parsed request or a built query: any other object is a type error", () => {
		// @ts-expect-error an empty object is neither
		expect(queryHelpers.countExtra({})._total).toBeDefined()
		// @ts-expect-error an unrelated object is neither
		expect(queryHelpers.countExtra({ foo: 1 })._total).toBeDefined()
	})

	it("reads a built ListQueryResult, the query a repository holds, by its pagination mode", () => {
		expect(queryHelpers.countExtra(built("cursor"))).toEqual({})
		expect(queryHelpers.countExtra(built("offset"))._total).toBeDefined()
	})
})

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

const sortedBy = (field: string, direction: "asc" | "desc" = "desc") => ({
	parsedSort: [{ direction, field }],
	sortOrderBy: { [field]: direction },
})

describe("queryHelpers.listOptions", () => {
	it("returns limit + 1, and the offset of the page", () => {
		expect(queryHelpers.listOptions({ limit: 20, ...sortedBy("created_at") })).toMatchObject({ limit: 21, offset: 0 })
		expect(queryHelpers.listOptions({ limit: 20, page: 3, ...sortedBy("created_at") }).offset).toBe(40)
	})

	it("passes sortOrderBy through and has no where without a cursor", () => {
		const options = queryHelpers.listOptions({ limit: 10, ...sortedBy("name", "asc") })
		expect(options.sortOrderBy).toEqual({ name: "asc" })
		expect(options.where).toBeUndefined()
	})

	it("orders by the sort keys then the id, with explicit null placement", () => {
		const options = queryHelpers.listOptions({ limit: 10, ...sortedBy("created_at") })
		const { sql: text } = dialect.sqlToQuery(sql.join(options.orderBy(getTableColumns(post)), sql`, `))
		expect(text).toBe('"post"."created_at" DESC NULLS FIRST, "post"."id" DESC NULLS FIRST')
	})

	it("gives a cursor request offset 0 and the keyset predicate", () => {
		const sort = sortedBy("created_at")
		const cursor = createCursor({ created_at: 7, id: 3 }, sort.parsedSort as SortField[])
		const options = queryHelpers.listOptions({ cursor, limit: 10, ...sort })
		expect(options.offset).toBe(0)
		const where = options.where?.RAW(getTableColumns(post))
		expect(where && dialect.sqlToQuery(where).params).toEqual([7, 7, 3])
	})

	it("orders by the id alone when there is no sort", () => {
		const options = queryHelpers.listOptions({ limit: 10, parsedSort: [], sortOrderBy: {} })
		expect(dialect.sqlToQuery(sql.join(options.orderBy(getTableColumns(post)), sql`, `)).sql).toBe(
			'"post"."id" DESC NULLS FIRST',
		)
	})

	it("refuses a cursor minted under another order, and a sort field the table lacks", () => {
		const cursor = createCursor({ id: 1, name: "a" }, [{ direction: "asc", field: "name" }])
		expect(() => queryHelpers.listOptions({ cursor, limit: 10, ...sortedBy("created_at") })).toThrow(CombError)
		const options = queryHelpers.listOptions({ limit: 10, ...sortedBy("ghost") })
		expect(() => options.orderBy(getTableColumns(post))).toThrow(CombError)
		expect(() =>
			queryHelpers.listOptions({ limit: 10, ...sortedBy("constructor") }).orderBy(getTableColumns(post)),
		).toThrow(CombError)
	})
})

/** The list query the paginate tests start from: five rows, newest first. */
const defaultQuery = {
	limit: 5,
	parsedSort: [{ direction: "desc" as const, field: "createdAt" }],
}

describe("queryHelpers.paginate — items and projection", () => {
	it("returns paginated result with hasMore=false", () => {
		const items = [
			{ _total: 2, id: "1" },
			{ _total: 2, id: "2" },
		]
		const [resultItems, pagination] = queryHelpers.paginate(items, { ...defaultQuery, limit: 5 })

		expect(pagination.count).toBe(2)
		expect(pagination.hasMore).toBe(false)
		expect(resultItems).toHaveLength(2)
		expect(pagination.limit).toBe(5)
		expect(pagination.page).toBe(1)
	})

	it("strips _total from returned items while keeping pagination.count", () => {
		const items = [
			{ _total: 2, id: "1", name: "a" },
			{ _total: 2, id: "2", name: "b" },
		]
		const [resultItems, pagination] = queryHelpers.paginate(items, { ...defaultQuery, limit: 5 })

		expect(pagination.count).toBe(2)
		expect(resultItems).toEqual([
			{ id: "1", name: "a" },
			{ id: "2", name: "b" },
		])
		for (const item of resultItems) {
			expect(item).not.toHaveProperty("_total")
		}
	})

	it("projects items through parsedFields after the slice", () => {
		const items = [
			{ _total: 10, email: "a@b.com", id: "1", name: "a" },
			{ _total: 10, email: "c@d.com", id: "2", name: "b" },
			{ _total: 10, email: "e@f.com", id: "3", name: "c" },
		]
		const [resultItems, pagination] = queryHelpers.paginate(items, {
			...defaultQuery,
			limit: 2,
			parsedFields: parseSelect("id"),
		})

		expect(pagination.count).toBe(10)
		expect(pagination.hasMore).toBe(true)
		expect(resultItems).toEqual([{ id: "1" }, { id: "2" }])
	})

	it("returns the full public row when parsedFields is null", () => {
		const items = [{ _total: 1, id: "1", name: "a" }]
		const [resultItems] = queryHelpers.paginate(items, { ...defaultQuery, limit: 10, parsedFields: null })

		expect(resultItems).toEqual([{ id: "1", name: "a" }])
	})
})

describe("queryHelpers.paginate — next cursor and hasMore", () => {
	it("encodes nextCursor from the pre-project last row", () => {
		const items = [
			{ _total: 3, createdAt: "2024-01-03", id: "c", name: "C" },
			{ _total: 3, createdAt: "2024-01-02", id: "b", name: "B" },
			{ _total: 3, createdAt: "2024-01-01", id: "a", name: "A" },
		]
		const [resultItems, pagination] = queryHelpers.paginate(items, {
			limit: 2,
			parsedFields: parseSelect("name"),
			parsedSort: [{ direction: "desc", field: "createdAt" }],
		})

		expect(resultItems).toEqual([{ name: "C" }, { name: "B" }])
		expect(pagination.hasMore).toBe(true)
		expect(decodeCursor(pagination.nextCursor)).toEqual({
			id: "b",
			sort: "createdAt.desc.nullsfirst",
			values: ["2024-01-02"],
		})
	})

	it("detects hasMore when items exceed limit", () => {
		const items = [
			{ _total: 10, id: "1" },
			{ _total: 10, id: "2" },
			{ _total: 10, id: "3" },
		]
		const [resultItems, pagination] = queryHelpers.paginate(items, { ...defaultQuery, limit: 2 })

		expect(pagination.hasMore).toBe(true)
		expect(resultItems).toHaveLength(2)
	})
})

describe("queryHelpers.paginate — count and page", () => {
	it("uses _total from first item", () => {
		const items = [{ _total: 42, id: "1" }]
		const [, pagination] = queryHelpers.paginate(items, { ...defaultQuery, limit: 10 })

		expect(pagination.count).toBe(42)
	})

	it("returns 0 count for empty results", () => {
		const [resultItems, pagination] = queryHelpers.paginate([], { ...defaultQuery, limit: 10 })

		expect(pagination.count).toBe(0)
		expect(pagination.hasMore).toBe(false)
		expect(resultItems).toHaveLength(0)
	})

	it("respects page parameter", () => {
		const items = [{ _total: 100, id: "1" }]
		const [, pagination] = queryHelpers.paginate(items, { ...defaultQuery, limit: 10, page: 3 })

		expect(pagination.page).toBe(3)
	})

	it("defaults page to 1", () => {
		const [, pagination] = queryHelpers.paginate([], { ...defaultQuery, limit: 10 })
		expect(pagination.page).toBe(1)
	})
})

describe("queryHelpers.paginate — nextCursor and cursor paging", () => {
	it("populates nextCursor when hasMore and items have id", () => {
		const items = [
			{ _total: 50, createdAt: "2024-01-03", id: "c" },
			{ _total: 50, createdAt: "2024-01-02", id: "b" },
			{ _total: 50, createdAt: "2024-01-01", id: "a" },
		]
		const [, pagination] = queryHelpers.paginate(items, {
			limit: 2,
			parsedSort: [{ direction: "desc", field: "createdAt" }],
		})

		expect(pagination.hasMore).toBe(true)
		expect(pagination.nextCursor).toBeTruthy()

		const decoded = decodeCursor(pagination.nextCursor)
		expect(decoded).toEqual({ id: "b", sort: "createdAt.desc.nullsfirst", values: ["2024-01-02"] })
	})

	it("returns page=null when cursor is present in query", () => {
		const items = [{ _total: 5, id: "1" }]
		const [, pagination] = queryHelpers.paginate(items, {
			cursor: "some-cursor",
			limit: 10,
			parsedSort: [{ direction: "desc", field: "createdAt" }],
		})

		expect(pagination.page).toBeNull()
	})
})

describe("queryHelpers.paginate — nextCursor edge cases", () => {
	it("builds nextCursor even for page-only when hasMore", () => {
		const items = [
			{ _total: 50, createdAt: "2024-03-01", id: "x" },
			{ _total: 50, createdAt: "2024-02-01", id: "y" },
			{ _total: 50, createdAt: "2024-01-01", id: "z" },
		]
		const [, pagination] = queryHelpers.paginate(items, {
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
		const [, pagination] = queryHelpers.paginate(items, {
			limit: 2,
			parsedSort: [{ direction: "desc", field: "name" }],
		})

		expect(pagination.hasMore).toBe(true)
		expect(pagination.nextCursor).toBeNull()
	})

	it("returns nextCursor null and hasMore false for empty results", () => {
		const [, pagination] = queryHelpers.paginate([], {
			limit: 10,
			parsedSort: [{ direction: "desc", field: "createdAt" }],
		})

		expect(pagination.nextCursor).toBeNull()
		expect(pagination.hasMore).toBe(false)
	})
})

describe("queryHelpers.project", () => {
	it("strips _total and keeps the rest when parsedFields is null", () => {
		expect(queryHelpers.project({ _total: 9, id: "1", name: "n" }, null)).toEqual({ id: "1", name: "n" })
	})

	it("projects a single row through parsedFields", () => {
		expect(queryHelpers.project({ _total: 9, email: "a@b.com", id: "1", name: "n" }, parseSelect("id"))).toEqual({
			id: "1",
		})
	})

	it("is a no-op on a row that already lacks _total when parsedFields is null", () => {
		expect(queryHelpers.project({ id: "1", name: "n" }, null)).toEqual({ id: "1", name: "n" })
	})

	it("drops _total even under a wildcard select", () => {
		expect(queryHelpers.project({ _total: 3, id: "1", name: "n" }, parseSelect("*"))).toEqual({ id: "1", name: "n" })
	})
})

describe("queryHelpers.paginate — count and the default sort", () => {
	it("reports null past the end, 0 for an empty first page, and null without countExtra", () => {
		expect(queryHelpers.paginate([], { limit: 2, page: 3, parsedSort: [] })[1].count).toBeNull()
		expect(queryHelpers.paginate([], { limit: 2, page: 1, parsedSort: [] })[1].count).toBe(0)
		expect(queryHelpers.paginate([{ id: "a" }], { limit: 2, parsedSort: [] })[1].count).toBeNull()
		expect(
			queryHelpers.paginate([{ _total: 4, id: "a" }], { cursor: "c", limit: 2, parsedSort: [] })[1].count,
		).toBeNull()
	})

	it("mints the next cursor under the default sort when the request named none", () => {
		const rows = [
			{ created_at: 2, id: "b" },
			{ created_at: 1, id: "a" },
		]
		const next = queryHelpers.paginate(rows, { limit: 1, parsedSort: [] })[1].nextCursor
		expect(decodeCursor(next)?.sort).toBe("created_at.desc.nullsfirst")
	})
})
