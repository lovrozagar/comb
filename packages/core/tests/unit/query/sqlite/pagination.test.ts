import type { SQL } from "drizzle-orm"
import { integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import type { CursorInfo } from "../../../../src/query/cursor.ts"
import { buildCursorSQL } from "../../../../src/query/sqlite/pagination.ts"
import type { SortField } from "../../../../src/query/types.ts"

const post = sqliteTable("post", {
	created_at: integer("created_at"),
	id: text("id").primaryKey(),
	title: text("title"),
})

const config = {
	columns: { id: post.id },
	sortColumns: { created_at: post.created_at, title: post.title },
	tableAlias: "p",
}

/* Compile through drizzle's own dialect rather than poking at queryChunks —
   this is the text and the bindings the database would actually receive. */
const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()

const compile = (built: SQL | null) => {
	if (!built) throw new Error("expected SQL, got null")
	return dialect.sqlToQuery(built)
}

function cursor(direction: "asc" | "desc", sortValue: unknown = 1700000000000): CursorInfo {
	return { direction, idValue: "pst_abc", sortValue }
}

const byCreatedAt = (direction: "asc" | "desc"): SortField[] => [{ direction, field: "created_at" }]

describe("buildCursorSQL", () => {
	it("returns null when there is no sort to break ties against", () => {
		expect(buildCursorSQL(cursor("desc"), [], config)).toBeNull()
	})

	it("compares forward for an ascending sort", () => {
		const { sql } = compile(buildCursorSQL(cursor("asc"), byCreatedAt("asc"), config))
		expect(sql).toBe("(p.created_at > ? OR (p.created_at = ? AND p.id > ?))")
	})

	it("compares backward for a descending sort", () => {
		const { sql } = compile(buildCursorSQL(cursor("desc"), byCreatedAt("desc"), config))
		expect(sql).toBe("(p.created_at < ? OR (p.created_at = ? AND p.id < ?))")
	})

	it("breaks ties on the id column, so equal sort values still page deterministically", () => {
		const { sql } = compile(buildCursorSQL(cursor("desc"), byCreatedAt("desc"), config))
		/* the second arm: same sort value, discriminate by id */
		expect(sql).toContain("p.created_at = ? AND p.id < ?")
	})

	it("binds cursor values as parameters rather than inlining them", () => {
		const { params, sql } = compile(buildCursorSQL(cursor("desc", 1700000000000), byCreatedAt("desc"), config))

		/* User-controlled values must never reach the query text */
		expect(sql).not.toContain("1700000000000")
		expect(sql).not.toContain("pst_abc")
		expect(params).toEqual([1700000000000, 1700000000000, "pst_abc"])
	})

	it("binds a string sort value without concatenating it into the text", () => {
		const { params, sql } = compile(buildCursorSQL(cursor("asc", "o'brien"), byCreatedAt("asc"), config))
		expect(sql).not.toContain("o'brien")
		expect(params[0]).toBe("o'brien")
	})

	it("falls back to createdAt when the sort field has no mapped column", () => {
		const { sql } = compile(buildCursorSQL(cursor("asc"), [{ direction: "asc", field: "unmapped" }], config))
		expect(sql).toContain("p.createdAt")
	})

	it("qualifies every reference with the configured table alias", () => {
		const { sql } = compile(buildCursorSQL(cursor("asc"), byCreatedAt("asc"), { ...config, tableAlias: "alias_x" }))
		expect(sql).toContain("alias_x.created_at")
		expect(sql).toContain("alias_x.id")
	})

	it("uses the sort column's database name, not its property name", () => {
		const renamed = sqliteTable("post", { id: text("id").primaryKey(), when: integer("created_at_ms") })
		const { sql } = compile(
			buildCursorSQL(cursor("asc"), [{ direction: "asc", field: "when" }], {
				columns: { id: renamed.id },
				sortColumns: { when: renamed.when },
				tableAlias: "p",
			}),
		)
		expect(sql).toContain("p.created_at_ms")
	})
})

describe("buildListQuery — refusing to page a table it cannot tiebreak", () => {
	it("throws rather than silently re-serving the first page", async () => {
		const { buildListQuery } = await import("../../../../src/query/sqlite/build-list-query.ts")
		const { encodeCursor } = await import("../../../../src/query/cursor.ts")
		const { CombError } = await import("../../../../src/error.ts")

		/* Primary key declared under a property other than the tiebreak name. */
		const odd = sqliteTable("odd", { created_at: integer("created_at"), pk: text("pk").primaryKey() })

		expect(() =>
			buildListQuery({
				parsed: {
					cursor: encodeCursor({ c: 1, d: "desc", i: "x" }),
					limit: 20,
					parsedSort: [{ direction: "desc", field: "created_at" }],
				},
				table: odd,
			}),
		).toThrow(CombError)
	})

	it("names the missing property and the consequence", async () => {
		const { buildListQuery } = await import("../../../../src/query/sqlite/build-list-query.ts")
		const { encodeCursor } = await import("../../../../src/query/cursor.ts")

		const odd = sqliteTable("odd", { created_at: integer("created_at"), pk: text("pk").primaryKey() })
		try {
			buildListQuery({
				parsed: {
					cursor: encodeCursor({ c: 1, d: "desc", i: "x" }),
					limit: 20,
					parsedSort: [{ direction: "desc", field: "created_at" }],
				},
				table: odd,
			})
			expect.unreachable("should throw")
		} catch (e) {
			const err = e as { errorKey: string; status: number }
			expect(err.errorKey).toBe("cursor_pagination_unsupported")
			expect(err.status).toBe(500)
		}
	})

	it("does not throw when no cursor was requested", async () => {
		const { buildListQuery } = await import("../../../../src/query/sqlite/build-list-query.ts")
		const odd = sqliteTable("odd", { created_at: integer("created_at"), pk: text("pk").primaryKey() })

		expect(() =>
			buildListQuery({
				parsed: { limit: 20, parsedSort: [{ direction: "desc", field: "created_at" }] },
				table: odd,
			}),
		).not.toThrow()
	})
})
