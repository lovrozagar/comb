import { getTableColumns, type SQL, sql } from "drizzle-orm"
import { integer, SQLiteDialect, sqliteTable } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { CombError } from "../error.ts"
import { createCursor, encodeCursor, sortSignature, verifiedCursor } from "./cursor.ts"
import { createListQuerySchema } from "./schema.ts"
import { buildListQuery } from "./sqlite/build-list-query.ts"
import { queryHelpers } from "./drizzle.ts"
import { parseSelect } from "./fields.ts"
import type { FilterAST, SortField } from "./types.ts"
import { CURSOR_SECRET, SIGNED } from "./__fixtures__/cursor-secret.ts"

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
	validated: true as const,
	parsedSort: [{ direction, field }],
	sortOrderBy: { [field]: direction },
})

describe("queryHelpers.listOptions", () => {
	it("returns limit + 1, and the offset of the page", () => {
		expect(queryHelpers.listOptions({ limit: 20, ...sortedBy("created_at") }, SIGNED)).toMatchObject({
			limit: 21,
			offset: 0,
		})
		expect(queryHelpers.listOptions({ limit: 20, page: 3, ...sortedBy("created_at") }, SIGNED).offset).toBe(40)
	})

	it("passes sortOrderBy through and has no where without a cursor", () => {
		const options = queryHelpers.listOptions({ limit: 10, ...sortedBy("name", "asc") }, SIGNED)
		expect(options.sortOrderBy).toEqual({ name: "asc" })
		expect(options.where).toBeUndefined()
	})

	it("orders by the sort keys then the id, with explicit null placement", () => {
		const options = queryHelpers.listOptions({ limit: 10, ...sortedBy("created_at") }, SIGNED)
		const { sql: text } = dialect.sqlToQuery(sql.join(options.orderBy(getTableColumns(post)), sql`, `))
		expect(text).toBe('"post"."created_at" DESC NULLS FIRST, "post"."id" DESC NULLS FIRST')
	})

	it("gives a cursor request offset 0 and the keyset predicate", () => {
		const sort = sortedBy("created_at")
		const cursor = createCursor({ created_at: 7, id: 3 }, sort.parsedSort as SortField[], SIGNED)
		const options = queryHelpers.listOptions({ cursor, limit: 10, ...sort }, SIGNED)
		expect(options.offset).toBe(0)
		const where = options.where?.RAW(getTableColumns(post))
		expect(where && dialect.sqlToQuery(where).params).toEqual([7, 7, 3])
	})

	it("orders by the id alone when there is no sort", () => {
		const options = queryHelpers.listOptions({ limit: 10, parsedSort: [], sortOrderBy: {} }, SIGNED)
		expect(dialect.sqlToQuery(sql.join(options.orderBy(getTableColumns(post)), sql`, `)).sql).toBe(
			'"post"."id" DESC NULLS FIRST',
		)
	})

	it("refuses a cursor minted under another order, and a sort field the table lacks", () => {
		const cursor = createCursor({ id: 1, name: "a" }, [{ direction: "asc", field: "name" }], SIGNED)
		expect(() => queryHelpers.listOptions({ cursor, limit: 10, ...sortedBy("created_at") }, SIGNED)).toThrow(CombError)
		const options = queryHelpers.listOptions({ limit: 10, ...sortedBy("ghost") }, SIGNED)
		expect(() => options.orderBy(getTableColumns(post))).toThrow(CombError)
		expect(() =>
			queryHelpers.listOptions({ limit: 10, ...sortedBy("constructor") }, SIGNED).orderBy(getTableColumns(post)),
		).toThrow(CombError)
	})
})

/** The list query the paginate tests start from: five rows, newest first. */
const defaultQuery = {
	limit: 5,
	validated: true as const,
	parsedSort: [{ direction: "desc" as const, field: "createdAt" }],
}

describe("queryHelpers.paginate — items and projection", () => {
	it("returns paginated result with hasMore=false", () => {
		const items = [
			{ _total: 2, id: "1" },
			{ _total: 2, id: "2" },
		]
		const [resultItems, pagination] = queryHelpers.paginate(items, { ...defaultQuery, limit: 5 }, SIGNED)

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
		const [resultItems, pagination] = queryHelpers.paginate(items, { ...defaultQuery, limit: 5 }, SIGNED)

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
			{ _total: 10, createdAt: "3", email: "a@b.com", id: "1", name: "a" },
			{ _total: 10, createdAt: "2", email: "c@d.com", id: "2", name: "b" },
			{ _total: 10, createdAt: "1", email: "e@f.com", id: "3", name: "c" },
		]
		const [resultItems, pagination] = queryHelpers.paginate(
			items,
			{
				...defaultQuery,
				limit: 2,
				parsedFields: parseSelect("id"),
			},
			SIGNED,
		)

		expect(pagination.count).toBe(10)
		expect(pagination.hasMore).toBe(true)
		expect(resultItems).toEqual([{ id: "1" }, { id: "2" }])
	})

	it("returns the full public row when parsedFields is null", () => {
		const items = [{ _total: 1, id: "1", name: "a" }]
		const [resultItems] = queryHelpers.paginate(items, { ...defaultQuery, limit: 10, parsedFields: null }, SIGNED)

		expect(resultItems).toEqual([{ id: "1", name: "a" }])
	})
})

/** A one-row page of `rows` under the default query, to call later */
const onePage = (rows: Array<Record<string, unknown>>) => () =>
	queryHelpers.paginate(rows, { ...defaultQuery, limit: 1 }, SIGNED)

describe("queryHelpers.paginate — next cursor and hasMore", () => {
	it("encodes nextCursor from the pre-project last row", () => {
		const items = [
			{ _total: 3, createdAt: "2024-01-03", id: "c", name: "C" },
			{ _total: 3, createdAt: "2024-01-02", id: "b", name: "B" },
			{ _total: 3, createdAt: "2024-01-01", id: "a", name: "A" },
		]
		const [resultItems, pagination] = queryHelpers.paginate(
			items,
			{
				limit: 2,
				parsedFields: parseSelect("name"),
				validated: true as const,
				parsedSort: [{ direction: "desc", field: "createdAt" }],
			},
			SIGNED,
		)

		expect(resultItems).toEqual([{ name: "C" }, { name: "B" }])
		expect(pagination.hasMore).toBe(true)
		expect(verifiedCursor(pagination.nextCursor as string, CURSOR_SECRET)).toEqual({
			id: "b",
			sort: "createdAt.desc.nullsfirst",
			values: ["2024-01-02"],
		})
	})

	it("detects hasMore when items exceed limit", () => {
		const items = [
			{ _total: 10, createdAt: "3", id: "1" },
			{ _total: 10, createdAt: "2", id: "2" },
			{ _total: 10, createdAt: "1", id: "3" },
		]
		const [resultItems, pagination] = queryHelpers.paginate(items, { ...defaultQuery, limit: 2 }, SIGNED)

		expect(pagination.hasMore).toBe(true)
		expect(resultItems).toHaveLength(2)
	})

	it("refuses to mint a cursor from rows without a sort key or the id, a wiring mistake (Q-D7)", () => {
		expect(onePage([{ id: "1" }, { id: "2" }])).toThrow(
			expect.objectContaining({
				cause: "paginate mints the next cursor from each row's createdAt; select them",
				errorKey: "sort_not_wired",
				status: 500,
			}),
		)
		expect(onePage([{ createdAt: "2" }, { createdAt: "1" }])).toThrow(
			expect.objectContaining({ cause: "paginate mints the next cursor from each row's id; select them" }),
		)
		expect(onePage([{ createdAt: "1", id: "1" }])).not.toThrow()
	})
})

describe("queryHelpers.paginate — count and page", () => {
	it("uses _total from first item", () => {
		const items = [{ _total: 42, id: "1" }]
		const [, pagination] = queryHelpers.paginate(items, { ...defaultQuery, limit: 10 }, SIGNED)

		expect(pagination.count).toBe(42)
	})

	it("returns 0 count for empty results", () => {
		const [resultItems, pagination] = queryHelpers.paginate([], { ...defaultQuery, limit: 10 }, SIGNED)

		expect(pagination.count).toBe(0)
		expect(pagination.hasMore).toBe(false)
		expect(resultItems).toHaveLength(0)
	})

	it("respects page parameter", () => {
		const items = [{ _total: 100, id: "1" }]
		const [, pagination] = queryHelpers.paginate(items, { ...defaultQuery, limit: 10, page: 3 }, SIGNED)

		expect(pagination.page).toBe(3)
	})

	it("defaults page to 1", () => {
		const [, pagination] = queryHelpers.paginate([], { ...defaultQuery, limit: 10 }, SIGNED)
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
		const [, pagination] = queryHelpers.paginate(
			items,
			{
				limit: 2,
				validated: true as const,
				parsedSort: [{ direction: "desc", field: "createdAt" }],
			},
			SIGNED,
		)

		expect(pagination.hasMore).toBe(true)
		expect(pagination.nextCursor).toBeTruthy()

		const decoded = verifiedCursor(pagination.nextCursor as string, CURSOR_SECRET)
		expect(decoded).toEqual({ id: "b", sort: "createdAt.desc.nullsfirst", values: ["2024-01-02"] })
	})

	it("returns page=null when cursor is present in query", () => {
		const items = [{ _total: 5, id: "1" }]
		const [, pagination] = queryHelpers.paginate(
			items,
			{
				cursor: "some-cursor",
				limit: 10,
				validated: true as const,
				parsedSort: [{ direction: "desc", field: "createdAt" }],
			},
			SIGNED,
		)

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
		const [, pagination] = queryHelpers.paginate(
			items,
			{
				limit: 2,
				page: 1,
				validated: true as const,
				parsedSort: [{ direction: "desc", field: "createdAt" }],
			},
			SIGNED,
		)

		expect(pagination.hasMore).toBe(true)
		expect(pagination.page).toBe(1)
		expect(pagination.nextCursor).toBeTruthy()
	})

	it("returns nextCursor null and hasMore false for empty results", () => {
		const [, pagination] = queryHelpers.paginate(
			[],
			{
				limit: 10,
				validated: true as const,
				parsedSort: [{ direction: "desc", field: "createdAt" }],
			},
			SIGNED,
		)

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
		expect(queryHelpers.paginate([], { limit: 2, page: 3, parsedSort: [] }, SIGNED)[1].count).toBeNull()
		expect(queryHelpers.paginate([], { limit: 2, page: 1, parsedSort: [] }, SIGNED)[1].count).toBe(0)
		expect(queryHelpers.paginate([{ id: "a" }], { limit: 2, parsedSort: [] }, SIGNED)[1].count).toBeNull()
		expect(
			queryHelpers.paginate([{ _total: 4, id: "a" }], { cursor: "c", limit: 2, parsedSort: [] }, SIGNED)[1].count,
		).toBeNull()
	})

	it("mints the next cursor under the tiebreak alone when the sort is empty, as listOptions orders", () => {
		const rows = [
			{ created_at: 2, id: "b" },
			{ created_at: 1, id: "a" },
		]
		const next = queryHelpers.paginate(rows, { limit: 1, parsedSort: [] }, SIGNED)[1].nextCursor
		expect(verifiedCursor(next as string, CURSOR_SECRET)?.sort).toBe("")
	})
})

describe("queryHelpers.listOptions — a cursor and an empty sort (B2, B3)", () => {
	const item = sqliteTable("item", {
		id: integer("id").primaryKey(),
		seen_at: integer("seen_at", { mode: "timestamp_ms" }),
	})

	it("answers a forged cursor with a 400, as buildListQuery does, not a TypeError", () => {
		const schema = createListQuerySchema({ sort: ["seen_at"] })
		const signature = sortSignature([{ direction: "desc", field: "seen_at" }])
		for (const forged of [
			encodeCursor({ i: 2, s: signature, v: ["not-a-date"] }, CURSOR_SECRET),
			encodeCursor({ i: "two", s: signature, v: [new Date(0).toISOString()] }, CURSOR_SECRET),
		]) {
			const parsed = schema.parse({ cursor: forged, order: "seen_at.desc" })
			const where = queryHelpers.listOptions(parsed, SIGNED).where?.RAW as (table: unknown) => SQL
			expect(() => where(item)).toThrow(expect.objectContaining({ errorKey: "invalid_cursor", status: 400 }))
		}
	})

	it("pages a schema with an empty sort by the tiebreak alone, the same in listOptions and buildListQuery", () => {
		const schema = createListQuerySchema({ sort: [] })
		const parsed = schema.parse({ limit: "2" })
		/* post has a created_at, which the old default sorted by in one place and not the other */
		const ordered = queryHelpers
			.listOptions(parsed, SIGNED)
			.orderBy(post)
			.map((by) => dialect.sqlToQuery(by).sql)
		const query = buildListQuery({ ...SIGNED, parsed, table: post })
		expect(ordered).toEqual(query.orderBy.map((by) => dialect.sqlToQuery(by as SQL).sql))
		const rows = [
			{ created_at: 30, id: 3 },
			{ created_at: 20, id: 2 },
			{ created_at: 10, id: 1 },
		]
		const next = queryHelpers.paginate(rows, parsed, SIGNED)[1].nextCursor as string
		const page = schema.safeParse({ cursor: next, limit: "2" })
		expect(page.success).toBe(true)
		expect(() => queryHelpers.listOptions(page.data as typeof parsed, SIGNED)).not.toThrow()
	})
})

describe("queryHelpers.paginate and the cursor length (Q6)", () => {
	const schema = createListQuerySchema({ sort: ["title", "id"] })

	it("throws on page 1 when the next cursor would pass what the list takes, and takes any it mints", () => {
		const query = schema.parse({ limit: "1", order: "title.asc" })
		const long = { id: "a", title: "字".repeat(2100) }
		expect(() => queryHelpers.paginate([long, { id: "b", title: "x" }], query, SIGNED)).toThrow(
			expect.objectContaining({ errorKey: "sort_not_wired" }),
		)
		const [, meta] = queryHelpers.paginate(
			[
				{ id: "a", title: "字".repeat(1050) },
				{ id: "b", title: "x" },
			],
			query,
			SIGNED,
		)
		expect(meta.nextCursor?.length).toBeGreaterThan(4096)
		expect(schema.safeParse({ cursor: meta.nextCursor, limit: "1", order: "title.asc" }).success).toBe(true)
	})
})
