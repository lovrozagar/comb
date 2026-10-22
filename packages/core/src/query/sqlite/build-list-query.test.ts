import { type SQL, sql } from "drizzle-orm"
import { integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { CombError } from "../../error.ts"
import { createCursor } from "../cursor.ts"
import { applyListQuery, buildListQuery } from "./build-list-query.ts"
import { likeSearch } from "./search.ts"
import { SEALED } from "../__fixtures__/cursor-secret.ts"

const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()

const organization = sqliteTable("organization", {
	_search: text("_search").notNull(),
	created_at: integer("created_at").notNull(),
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	status: text("status").notNull(),
})

type ListParsed = Parameters<typeof buildListQuery>[0]["parsed"]

/** The offset-paginated first page every field spelled out, for tests to override */
const offsetPage: ListParsed = {
	cursor: undefined,
	filterAst: null,
	lang: undefined,
	limit: 20,
	page: 1,
	parsedFields: null,
	parsedSort: [],
	validated: true as const,
	q: undefined,
	sortOrderBy: {},
}

/** A filter of one condition, status eq active */
const activeFilter: ListParsed["filterAst"] = {
	root: {
		conditions: [{ field: "status", operator: "eq", value: "active" }],
		logic: "and",
		subgroups: [],
	},
}

/** A computed sort that orders by a raw column in the given direction */
const customSort = (dir: string): SQL => sql`custom_column ${sql.raw(dir)}`

/** A parsed list request sorted ascending by one field */
const parsedWith = (field: string) => ({
	filterAst: null,
	limit: 10,
	validated: true as const,
	parsedSort: [{ direction: "asc" as const, field }],
})

describe("buildListQuery — pagination", () => {
	it("returns limit+1 and page-based offset", () => {
		const result = buildListQuery({ ...SEALED, parsed: { ...offsetPage, page: 3 }, table: organization })

		expect(result.limit).toBe(21)
		expect(result.offset).toBe(40)
		expect(result.meta).toEqual({ limit: 20, page: 3, type: "offset" })
	})

	it("defaults to page 1 when page is undefined", () => {
		const result = buildListQuery({
			...SEALED,
			parsed: { ...offsetPage, limit: 10, page: undefined },
			table: organization,
		})

		expect(result.limit).toBe(11)
		expect(result.offset).toBe(0)
		expect(result.meta).toEqual({ limit: 10, page: 1, type: "offset" })
	})

	it("uses cursor pagination with offset=0 and cursor where clause", () => {
		const cursor = createCursor(
			{ created_at: 1000, id: "org_123" },
			[{ direction: "desc", field: "created_at" }],
			SEALED,
		)
		const result = buildListQuery({
			...SEALED,
			parsed: {
				...offsetPage,
				cursor,
				page: undefined,
				validated: true as const,
				parsedSort: [{ direction: "desc", field: "created_at" }],
				sortOrderBy: { created_at: "desc" },
			},
			table: organization,
		})

		expect(result.offset).toBe(0)
		expect(result.meta.type).toBe("cursor")
		expect(result.where).not.toBeNull()
	})
})

describe("buildListQuery — where", () => {
	it("converts filterAst to where SQL", () => {
		const result = buildListQuery({
			...SEALED,
			parsed: { ...offsetPage, filterAst: activeFilter },
			table: organization,
		})

		expect(result.where).not.toBeNull()
	})

	it("returns null where when filterAst is null", () => {
		const result = buildListQuery({ ...SEALED, parsed: offsetPage, table: organization })

		expect(result.where).toBeUndefined()
	})

	it("combines baseWhere with filter where", () => {
		const baseWhere = sql`user_id = 'abc'`
		const result = buildListQuery({
			...SEALED,
			baseWhere,
			parsed: { ...offsetPage, filterAst: activeFilter },
			table: organization,
		})

		expect(result.where).not.toBeNull()
		/* both baseWhere and filter should be present in combined where */
	})

	it("returns baseWhere as-is when no filter", () => {
		const baseWhere = sql`user_id = 'abc'`
		const result = buildListQuery({ ...SEALED, baseWhere, parsed: offsetPage, table: organization })

		expect(result.where).toBe(baseWhere)
	})
})

describe("buildListQuery — sort", () => {
	it("converts parsedSort to orderBy SQL with id tiebreaker", () => {
		const result = buildListQuery({
			...SEALED,
			parsed: {
				...offsetPage,
				validated: true as const,
				parsedSort: [{ direction: "desc", field: "created_at" }],
				sortOrderBy: { created_at: "desc" },
			},
			table: organization,
		})

		expect(result.orderBy).toHaveLength(2)
	})
})

describe("buildListQuery — sort and cursors", () => {
	it("rejects a cursor minted under a different order with a 400", () => {
		const cursor = createCursor(
			{ created_at: 1000, id: "org_123" },
			[{ direction: "desc", field: "created_at" }],
			SEALED,
		)
		expect(() =>
			buildListQuery({
				...SEALED,
				parsed: {
					cursor,
					filterAst: null,
					limit: 20,
					validated: true as const,
					parsedSort: [{ direction: "asc", field: "created_at" }],
				},
				table: organization,
			}),
		).toThrow(expect.objectContaining({ status: 400 }))
	})

	it("supports computed sorts via @ prefix", () => {
		const result = buildListQuery({
			...SEALED,
			computedSorts: { "@relevance": customSort },
			parsed: { ...offsetPage, validated: true as const, parsedSort: [{ direction: "desc", field: "@relevance" }] },
			table: organization,
		})

		expect(result.orderBy.length).toBeGreaterThanOrEqual(1)
	})

	it("orders by the id tiebreak alone when parsedSort is empty", () => {
		const result = buildListQuery({ ...SEALED, parsed: offsetPage, table: organization })
		expect(result.orderBy.map((part) => dialect.sqlToQuery(part).sql)).toEqual(['"organization"."id" DESC NULLS FIRST'])
	})

	it("refuses a cursor under a computed sort, which keyset cannot express", () => {
		const cursor = createCursor({ id: "o1" }, [{ direction: "desc", field: "@relevance" }], SEALED)
		const parsed = {
			...offsetPage,
			cursor,
			validated: true as const,
			parsedSort: [{ direction: "desc" as const, field: "@relevance" }],
		}
		expect(() =>
			buildListQuery({ ...SEALED, computedSorts: { "@relevance": customSort }, parsed, table: organization }),
		).toThrow(expect.objectContaining({ errorKey: "cursor_pagination_unsupported" }))
	})
})

describe("buildListQuery — search", () => {
	it("passes through search query trimmed", () => {
		const result = buildListQuery({
			...SEALED,
			parsed: { ...offsetPage, q: "  hello world  " },
			search: likeSearch(organization._search),
			table: organization,
		})

		expect(result.search).toBe("hello world")
	})

	it("refuses a q it has no search resolver for, rather than ignoring it", () => {
		expect(() =>
			buildListQuery({
				...SEALED,
				parsed: { cursor: undefined, filterAst: null, limit: 20, page: 1, parsedSort: [], q: "hello" },
				table: organization,
			}),
		).toThrow(CombError)
	})

	it("returns null search when q is undefined", () => {
		const result = buildListQuery({ ...SEALED, parsed: offsetPage, table: organization })

		expect(result.search).toBeNull()
	})
})

describe("buildListQuery — the search option", () => {
	it("search option produces WHERE when q is present", () => {
		const result = buildListQuery({
			...SEALED,
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
			...SEALED,
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
})

describe("buildListQuery — the search option without a q", () => {
	it("search option adds no WHERE when q is empty", () => {
		const result = buildListQuery({
			...SEALED,
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
			...SEALED,
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
})

describe("buildListQuery — the search option with a cursor", () => {
	it("search works with cursor pagination", () => {
		const cursor = createCursor(
			{ created_at: 1000, id: "org_123" },
			[{ direction: "desc", field: "created_at" }],
			SEALED,
		)
		const result = buildListQuery({
			...SEALED,
			parsed: {
				cursor,
				filterAst: null,
				limit: 20,
				page: undefined,
				validated: true as const,
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

describe("buildListQuery — sort fields it cannot order by (Q-L3)", () => {
	it.each(["ghost", "constructor", "toString"])("throws for %s, which is not a column of the table", (field) => {
		expect(() => buildListQuery({ ...SEALED, parsed: parsedWith(field), table: organization })).toThrow(CombError)
	})

	it("throws for a computed sort with no resolver, or one that is not its own entry", () => {
		expect(() => buildListQuery({ ...SEALED, parsed: parsedWith("@relevance"), table: organization })).toThrow(
			CombError,
		)
		expect(() =>
			buildListQuery({ ...SEALED, computedSorts: {}, parsed: parsedWith("@constructor"), table: organization }),
		).toThrow(CombError)
	})
})

describe("buildListQuery — a table without an id column", () => {
	const tag = sqliteTable("tag", { name: text("name").notNull() })
	const parsed = {
		filterAst: null,
		limit: 5,
		validated: true as const,
		parsedSort: [{ direction: "asc" as const, field: "name" }],
	}

	it("orders without a tiebreak, and refuses a cursor it could not honor", () => {
		expect(buildListQuery({ ...SEALED, parsed, table: tag }).orderBy).toHaveLength(1)
		const cursor = createCursor({ id: "x", name: "a" }, parsed.parsedSort, SEALED)
		expect(() => buildListQuery({ ...SEALED, parsed: { ...parsed, cursor }, table: tag })).toThrow(CombError)
	})
})

describe("buildListQuery — cursor values of the wrong type (S-M6)", () => {
	const event = sqliteTable("event", {
		active: integer("active", { mode: "boolean" }),
		id: text("id").primaryKey(),
		seen_at: integer("seen_at", { mode: "timestamp_ms" }),
	})
	const run = (field: string, row: Record<string, unknown>) => {
		const parsedSort = [{ direction: "desc" as const, field }]
		const cursor = createCursor({ id: "evt_1", ...row }, parsedSort, SEALED)
		return () =>
			buildListQuery({
				...SEALED,
				parsed: { cursor, filterAst: null, limit: 5, parsedSort, validated: true },
				table: event,
			})
	}

	it.each([
		["a string on a timestamp column", "seen_at", { seen_at: "2024" }],
		["a number on a timestamp column", "seen_at", { seen_at: 1 }],
		["a string on a boolean column", "active", { active: "yes" }],
		["a number as the id", "seen_at", { id: 7, seen_at: new Date(1) }],
	])("answers %s with a 400 invalid_cursor", (_case, field, row) => {
		expect(run(field, row)).toThrow(expect.objectContaining({ errorKey: "invalid_cursor", status: 400 }))
	})

	it("accepts the values a real row encodes, nulls included", () => {
		expect(run("seen_at", { seen_at: new Date(1) })).not.toThrow()
		expect(run("seen_at", { seen_at: null })).not.toThrow()
		expect(run("active", { active: false })).not.toThrow()
	})
})

describe("buildListQuery — no sort and no created_at to default to", () => {
	it("orders by the id alone, descending", () => {
		const note = sqliteTable("note", { id: text("id").primaryKey() })
		const { orderBy } = buildListQuery({
			...SEALED,
			parsed: { filterAst: null, limit: 5, parsedSort: [] },
			table: note,
		})
		expect(orderBy.map((part) => dialect.sqlToQuery(part).sql)).toEqual(['"note"."id" DESC NULLS FIRST'])
	})
})

describe("applyListQuery", () => {
	it("applies where, order, limit and offset, and skips where when there is none", () => {
		const calls: string[] = []
		const query = {
			limit: (n: number) => (calls.push(`limit ${n}`), query),
			offset: (n: number) => (calls.push(`offset ${n}`), query),
			orderBy: (...order: SQL[]) => (calls.push(`orderBy ${order.length}`), query),
			where: () => (calls.push("where"), query),
		}
		const built = buildListQuery({
			...SEALED,
			parsed: { filterAst: null, limit: 2, page: 2, parsedSort: [] },
			table: organization,
		})
		applyListQuery(query, built)
		/* an empty sort orders by the tiebreak id alone */
		expect(calls).toEqual(["orderBy 1", "limit 3", "offset 2"])
		applyListQuery(query, { ...built, where: sql`1` })
		expect(calls.at(3)).toBe("where")
	})
})
