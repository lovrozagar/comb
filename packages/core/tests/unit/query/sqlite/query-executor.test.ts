/**
 * QueryExecutor.build — the orchestration that turns a validated list-query
 * input into a where clause, an ordering, and a pagination window.
 */
import type { SQL } from "drizzle-orm"
import { integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { encodeCursor } from "../../../../src/query/cursor.ts"
import { QueryExecutor } from "../../../../src/query/sqlite/executor.ts"
import type { ListQueryCapabilities } from "../../../../src/query/types.ts"

const post = sqliteTable("post", {
	createdAt: integer("createdAt"),
	id: text("id").primaryKey(),
	status: text("status"),
	title: text("title"),
	views: integer("views"),
})

/* A table with no id column, to exercise the paths that need one */
const idless = sqliteTable("idless", { name: text("name") })

const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()
const compile = (built: SQL) => dialect.sqlToQuery(built)

function capabilities(over: Partial<ListQueryCapabilities> = {}): ListQueryCapabilities {
	return {
		computedFilterFields: {},
		computedSortFields: new Set(),
		filterFields: { createdAt: "date", status: "enum", title: "string", views: "number" },
		pagination: { defaultLimit: 20, maxLimit: 100 },
		relationFilterFields: {},
		searchFields: new Set(["title"]),
		sortFields: new Set(["createdAt", "title", "views"]),
		...over,
	}
}

const build = (input: Record<string, unknown>, over: Partial<ListQueryCapabilities> = {}) =>
	QueryExecutor.build({ capabilities: capabilities(over), input: input as never, table: post })

describe("QueryExecutor.build — where clause", () => {
	it("omits the where clause when no filter was supplied", () => {
		expect(build({}).where).toBeNull()
	})

	it("omits it when the filter string does not parse", () => {
		expect(build({ filter: "garbage" }).where).toBeNull()
	})

	it("lowers a parsed filter to SQL", () => {
		const result = build({ filter: "status.eq.draft" })
		expect(compile(result.where!).params).toEqual(["draft"])
	})

	it("lowers title.like.% to an escaped literal rather than match-all", () => {
		const result = build({ filter: "title.like.%" })
		const { params, sql } = compile(result.where!)
		expect(params).toEqual(["\\%"])
		expect(sql.toLowerCase()).toContain("escape")
	})

	it("ands the cursor predicate onto an existing filter", () => {
		const cursor = encodeCursor({ c: 5, d: "desc", i: "p9" })
		const result = build({ cursor, filter: "status.eq.draft", order: "views.desc" })
		const { params, sql } = compile(result.where!)

		expect(sql.toLowerCase()).toContain(" and ")
		expect(params).toContain("draft")
		expect(params).toContain("p9")
	})

	it("uses the cursor predicate alone when there is no filter", () => {
		const cursor = encodeCursor({ c: 5, d: "desc", i: "p9" })
		const result = build({ cursor, order: "views.desc" })
		expect(compile(result.where!).params).toContain("p9")
	})
})

describe("QueryExecutor.build — ordering", () => {
	it("orders by the requested field and appends the id tiebreak", () => {
		const result = build({ order: "views.asc" })
		expect(result.orderBy).toHaveLength(2)
		expect(compile(result.orderBy[0]!).sql.toLowerCase()).toContain("asc")
		/* the tiebreak follows the primary direction */
		expect(compile(result.orderBy[1]!).sql.toLowerCase()).toContain("asc")
	})

	it("falls back to createdAt descending when no order is requested", () => {
		const result = build({})
		expect(compile(result.orderBy[0]!).sql).toContain("createdAt")
		expect(compile(result.orderBy[0]!).sql.toLowerCase()).toContain("desc")
	})

	it("returns no ordering at all when the table has neither sort column nor createdAt", () => {
		const result = QueryExecutor.build({
			capabilities: capabilities({ sortFields: new Set() }),
			input: {} as never,
			table: idless,
		})
		expect(result.orderBy).toEqual([])
	})

	it("drops a sort field the capabilities do not allow", () => {
		/* The id tiebreak is only appended when something else already ordered the
		   query, so a rejected sort leaves the result unordered. Reaching this
		   through createListQuerySchema is impossible — it rejects an unknown sort
		   field with a 400 first — but a direct caller of QueryExecutor gets
		   non-deterministic paging. Asserted as-is so a change is deliberate. */
		const result = build({ order: "secret.asc" })
		expect(result.orderBy).toEqual([])
	})
})

describe("QueryExecutor.build — pagination", () => {
	it("defaults to the configured page size and adds one for lookahead", () => {
		const result = build({})
		expect(result.meta).toMatchObject({ limit: 20, page: 1, type: "offset" })
		expect(result.limit).toBe(21)
		expect(result.offset).toBe(0)
	})

	it("clamps a limit above the maximum", () => {
		expect(build({ limit: 5000 }).meta.limit).toBe(100)
	})

	it("clamps a limit below one", () => {
		expect(build({ limit: 0 }).meta.limit).toBe(1)
		expect(build({ limit: -10 }).meta.limit).toBe(1)
	})

	it("computes the offset from the page", () => {
		const result = build({ limit: 10, page: 4 })
		expect(result.offset).toBe(30)
		expect(result.meta.page).toBe(4)
	})

	it("treats a page below one as page one", () => {
		expect(build({ page: 0 }).offset).toBe(0)
		expect(build({ page: -3 }).offset).toBe(0)
	})

	it("switches to cursor mode when the cursor resolves", () => {
		const cursor = encodeCursor({ c: 5, d: "desc", i: "p9" })
		const result = build({ cursor, order: "views.desc" })

		expect(result.meta.type).toBe("cursor")
		expect(result.meta.page).toBe(1)
		expect(result.offset).toBe(0)
		expect(result.cursor).not.toBeNull()
	})

	it("ignores a cursor encoded for the opposite direction", () => {
		const cursor = encodeCursor({ c: 5, d: "asc", i: "p9" })
		/* queried desc — the cursor is stale, so fall back to offset */
		const result = build({ cursor, order: "views.desc" })
		expect(result.meta.type).toBe("offset")
	})

	it("declines a cursor over a computed sort field, which has no column to seek on", () => {
		const cursor = encodeCursor({ c: 5, d: "desc", i: "p9" })
		const result = QueryExecutor.build({
			capabilities: capabilities({ computedSortFields: new Set(["@rank"]) }),
			input: { cursor, order: "@rank.desc" } as never,
			table: post,
		})
		expect(result.cursor).toBeNull()
		expect(result.where).toBeNull()
	})

	it("ignores a cursor when the table has no id column to break ties on", () => {
		const cursor = encodeCursor({ c: 5, d: "desc", i: "x" })
		const result = QueryExecutor.build({
			capabilities: capabilities(),
			input: { cursor } as never,
			table: idless,
		})
		expect(result.meta.type).toBe("offset")
	})
})

describe("QueryExecutor.build — cursor predicate direction", () => {
	it("seeks backwards for a descending cursor", () => {
		const cursor = encodeCursor({ c: 5, d: "desc", i: "p9" })
		const { sql } = compile(build({ cursor, order: "views.desc" }).where!)
		expect(sql).toContain("<")
		expect(sql).not.toContain(">")
	})

	it("seeks forwards for an ascending cursor", () => {
		const cursor = encodeCursor({ c: 5, d: "asc", i: "p9" })
		const { sql } = compile(build({ cursor, order: "views.asc" }).where!)
		expect(sql).toContain(">")
		expect(sql).not.toContain("<")
	})
})

describe("QueryExecutor.build — search passthrough", () => {
	it("trims the search term", () => {
		expect(build({ q: "  hello  " }).search).toBe("hello")
	})

	it("reports null for an absent or blank term", () => {
		expect(build({}).search).toBeNull()
		expect(build({ q: "   " }).search).toBeNull()
	})
})
