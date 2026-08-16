import { type SQL, sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { createCursor } from "../../../../src/query/cursor.ts"
import { buildListQuery } from "../../../../src/query/sqlite/build-list-query.ts"
import { likeSearch } from "../../../../src/query/sqlite/search.ts"

const organization = sqliteTable("organization", {
	_search: text("_search").notNull(),
	created_at: integer("created_at").notNull(),
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	status: text("status").notNull(),
})

describe("buildListQuery", () => {
	it("returns limit+1 and page-based offset", () => {
		const result = buildListQuery({
			parsed: {
				cursor: undefined,
				filterAst: null,
				lang: undefined,
				limit: 20,
				page: 3,
				parsedFields: null,
				parsedSort: [],
				q: undefined,
				sortOrderBy: {},
			},
			table: organization,
		})

		expect(result.limit).toBe(21)
		expect(result.offset).toBe(40)
		expect(result.meta).toEqual({ limit: 20, page: 3, type: "offset" })
	})

	it("defaults to page 1 when page is undefined", () => {
		const result = buildListQuery({
			parsed: {
				cursor: undefined,
				filterAst: null,
				lang: undefined,
				limit: 10,
				page: undefined,
				parsedFields: null,
				parsedSort: [],
				q: undefined,
				sortOrderBy: {},
			},
			table: organization,
		})

		expect(result.limit).toBe(11)
		expect(result.offset).toBe(0)
		expect(result.meta).toEqual({ limit: 10, page: 1, type: "offset" })
	})

	it("converts parsedSort to orderBy SQL with id tiebreaker", () => {
		const result = buildListQuery({
			parsed: {
				cursor: undefined,
				filterAst: null,
				lang: undefined,
				limit: 20,
				page: 1,
				parsedFields: null,
				parsedSort: [{ direction: "desc", field: "created_at" }],
				q: undefined,
				sortOrderBy: { created_at: "desc" },
			},
			table: organization,
		})

		expect(result.orderBy).toHaveLength(2)
	})

	it("converts filterAst to where SQL", () => {
		const result = buildListQuery({
			parsed: {
				cursor: undefined,
				filterAst: {
					root: {
						conditions: [{ field: "status", operator: "eq", value: "active" }],
						logic: "and",
						subgroups: [],
					},
				},
				lang: undefined,
				limit: 20,
				page: 1,
				parsedFields: null,
				parsedSort: [],
				q: undefined,
				sortOrderBy: {},
			},
			table: organization,
		})

		expect(result.where).not.toBeNull()
	})

	it("returns null where when filterAst is null", () => {
		const result = buildListQuery({
			parsed: {
				cursor: undefined,
				filterAst: null,
				lang: undefined,
				limit: 20,
				page: 1,
				parsedFields: null,
				parsedSort: [],
				q: undefined,
				sortOrderBy: {},
			},
			table: organization,
		})

		expect(result.where).toBeUndefined()
	})

	it("combines baseWhere with filter where", () => {
		const baseWhere = sql`user_id = 'abc'`
		const result = buildListQuery({
			baseWhere,
			parsed: {
				cursor: undefined,
				filterAst: {
					root: {
						conditions: [{ field: "status", operator: "eq", value: "active" }],
						logic: "and",
						subgroups: [],
					},
				},
				lang: undefined,
				limit: 20,
				page: 1,
				parsedFields: null,
				parsedSort: [],
				q: undefined,
				sortOrderBy: {},
			},
			table: organization,
		})

		expect(result.where).not.toBeNull()
		/* both baseWhere and filter should be present in combined where */
	})

	it("returns baseWhere as-is when no filter", () => {
		const baseWhere = sql`user_id = 'abc'`
		const result = buildListQuery({
			baseWhere,
			parsed: {
				cursor: undefined,
				filterAst: null,
				lang: undefined,
				limit: 20,
				page: 1,
				parsedFields: null,
				parsedSort: [],
				q: undefined,
				sortOrderBy: {},
			},
			table: organization,
		})

		expect(result.where).toBe(baseWhere)
	})

	it("uses cursor pagination with offset=0 and cursor where clause", () => {
		const cursor = createCursor({ created_at: 1000, id: "org_123" }, "created_at")
		const result = buildListQuery({
			parsed: {
				cursor,
				filterAst: null,
				lang: undefined,
				limit: 20,
				page: undefined,
				parsedFields: null,
				parsedSort: [{ direction: "desc", field: "created_at" }],
				q: undefined,
				sortOrderBy: { created_at: "desc" },
			},
			table: organization,
		})

		expect(result.offset).toBe(0)
		expect(result.meta.type).toBe("cursor")
		expect(result.where).not.toBeNull()
	})

	it("passes through search query trimmed", () => {
		const result = buildListQuery({
			parsed: {
				cursor: undefined,
				filterAst: null,
				lang: undefined,
				limit: 20,
				page: 1,
				parsedFields: null,
				parsedSort: [],
				q: "  hello world  ",
				sortOrderBy: {},
			},
			table: organization,
		})

		expect(result.search).toBe("hello world")
	})

	it("supports computed sorts via @ prefix", () => {
		const customSort = (dir: string): SQL => sql`custom_column ${sql.raw(dir)}`
		const result = buildListQuery({
			computedSorts: { "@relevance": customSort },
			parsed: {
				cursor: undefined,
				filterAst: null,
				lang: undefined,
				limit: 20,
				page: 1,
				parsedFields: null,
				parsedSort: [{ direction: "desc", field: "@relevance" }],
				q: undefined,
				sortOrderBy: {},
			},
			table: organization,
		})

		expect(result.orderBy.length).toBeGreaterThanOrEqual(1)
	})

	it("returns null search when q is undefined", () => {
		const result = buildListQuery({
			parsed: {
				cursor: undefined,
				filterAst: null,
				lang: undefined,
				limit: 20,
				page: 1,
				parsedFields: null,
				parsedSort: [],
				q: undefined,
				sortOrderBy: {},
			},
			table: organization,
		})

		expect(result.search).toBeNull()
	})

	it("uses default desc(created_at) sort when parsedSort is empty", () => {
		const result = buildListQuery({
			parsed: {
				cursor: undefined,
				filterAst: null,
				lang: undefined,
				limit: 20,
				page: 1,
				parsedFields: null,
				parsedSort: [],
				q: undefined,
				sortOrderBy: {},
			},
			table: organization,
		})

		expect(result.orderBy.length).toBeGreaterThan(0)
	})

	it("search option produces WHERE when q is present", () => {
		const result = buildListQuery({
			parsed: {
				cursor: undefined,
				filterAst: null,
				limit: 20,
				page: 1,
				parsedSort: [],
				q: "hello",
			},
			search: likeSearch(organization._search),
			table: organization,
		})

		expect(result.where).toBeTruthy()
	})

	it("search option combined with baseWhere ANDs both", () => {
		const baseWhere = sql`${organization.status} = 'active'`
		const result = buildListQuery({
			baseWhere,
			parsed: {
				cursor: undefined,
				filterAst: null,
				limit: 20,
				page: 1,
				parsedSort: [],
				q: "test",
			},
			search: likeSearch(organization._search),
			table: organization,
		})

		expect(result.where).toBeTruthy()
		expect(result.where).not.toBe(baseWhere)
	})

	it("search option adds no WHERE when q is empty", () => {
		const result = buildListQuery({
			parsed: {
				cursor: undefined,
				filterAst: null,
				limit: 20,
				page: 1,
				parsedSort: [],
				q: "",
			},
			search: likeSearch(organization._search),
			table: organization,
		})

		expect(result.where).toBeUndefined()
	})

	it("search option adds no WHERE when q is undefined", () => {
		const result = buildListQuery({
			parsed: {
				cursor: undefined,
				filterAst: null,
				limit: 20,
				page: 1,
				parsedSort: [],
				q: undefined,
			},
			search: likeSearch(organization._search),
			table: organization,
		})

		expect(result.where).toBeUndefined()
	})

	it("search works with cursor pagination", () => {
		const cursor = createCursor({ created_at: 1000, id: "org_123" }, "created_at")
		const result = buildListQuery({
			parsed: {
				cursor,
				filterAst: null,
				limit: 20,
				page: undefined,
				parsedSort: [{ direction: "desc", field: "created_at" }],
				q: "search term",
			},
			search: likeSearch(organization._search),
			table: organization,
		})

		expect(result.offset).toBe(0)
		expect(result.meta.type).toBe("cursor")
		expect(result.where).toBeTruthy()
	})
})
