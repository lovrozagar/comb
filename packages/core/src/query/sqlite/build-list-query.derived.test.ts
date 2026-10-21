/**
 * buildDerivedListQuery — the variant for a subquery or CTE, where sort columns
 * are supplied rather than read off a table. Its cursor arm handles NULL sort
 * values explicitly, which is the part most easily got wrong.
 */
import { type SQL, sql as drizzleSql } from "drizzle-orm"
import { integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { CombError } from "../../error.ts"
import { createCursor } from "../cursor.ts"
import type { SortField } from "../types.ts"
import { buildDerivedListQuery } from "./build-list-query.ts"
import { SIGNED } from "../__fixtures__/cursor-secret.ts"

const derived = sqliteTable("derived", {
	id: text("id").primaryKey(),
	published_at: integer("published_at"),
	title: text("title"),
})

const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()
const compile = (built: SQL) => dialect.sqlToQuery(built)

/* Small helper so the tests read as clauses rather than template noise */
const compileSql = (fragment: string): SQL => drizzleSql.raw(fragment)

const base = {
	idColumn: derived.id,
	sortColumns: { published_at: derived.published_at, title: derived.title },
}

const parsed = (over: Record<string, unknown> = {}) => ({
	limit: 20,
	parsedSort: [{ direction: "desc" as const, field: "published_at" as const }],
	...over,
})

describe("buildDerivedListQuery — pagination mode", () => {
	it("uses offset pagination when no cursor is given", () => {
		const result = buildDerivedListQuery({ ...SIGNED, ...base, parsed: parsed({ page: 3 }) })

		expect(result.meta.type).toBe("offset")
		expect(result.meta.page).toBe(3)
		expect(result.offset).toBe(40)
		/* one extra row so the caller can detect a next page */
		expect(result.limit).toBe(21)
	})

	it("defaults to page 1 when none is given", () => {
		const result = buildDerivedListQuery({ ...SIGNED, ...base, parsed: parsed() })
		expect(result.offset).toBe(0)
		expect(result.meta.page).toBe(1)
	})

	it("switches to cursor mode when a cursor resolves against the sort column", () => {
		const cursor = createCursor({ id: "d_9", published_at: 1700000000000 }, parsed().parsedSort, SIGNED)
		const result = buildDerivedListQuery({ ...SIGNED, ...base, parsed: parsed({ cursor }) })

		expect(result.meta.type).toBe("cursor")
		expect(result.meta.page).toBe(1)
		expect(result.offset).toBe(0)
	})

	it("refuses a cursor when a sort field has no supplied column", () => {
		const sort: SortField[] = [{ direction: "desc", field: "unmapped" }]
		const cursor = createCursor({ id: "d_9", unmapped: 1 }, sort, SIGNED)
		expect(() =>
			buildDerivedListQuery({ ...SIGNED, ...base, parsed: { cursor, limit: 20, parsedSort: sort } }),
		).toThrow(CombError)
	})

	it("trims the search term and reports null when it is empty", () => {
		expect(buildDerivedListQuery({ ...SIGNED, ...base, parsed: parsed({ q: "  hi  " }) }).search).toBe("hi")
		expect(buildDerivedListQuery({ ...SIGNED, ...base, parsed: parsed() }).search).toBeNull()
	})
})

describe("buildDerivedListQuery — ordering", () => {
	it("places NULLs last ascending and first descending, then breaks ties on id", () => {
		const asc = buildDerivedListQuery({
			...SIGNED,
			...base,
			parsed: parsed({ parsedSort: [{ direction: "asc", field: "published_at" }] }),
		})
		expect(compile(asc.orderBy[0]!).sql).toContain("ASC NULLS LAST")

		const desc = buildDerivedListQuery({ ...SIGNED, ...base, parsed: parsed() })
		expect(compile(desc.orderBy[0]!).sql).toContain("DESC NULLS FIRST")

		/* the id tiebreak is always appended, matching the primary direction */
		expect(desc.orderBy).toHaveLength(2)
		expect(compile(desc.orderBy[1]!).sql.toLowerCase()).toContain("desc")
	})

	it("orders by id alone when no sort was requested", () => {
		const result = buildDerivedListQuery({ ...SIGNED, ...base, parsed: parsed({ parsedSort: [] }) })
		expect(result.orderBy).toHaveLength(1)
		expect(compile(result.orderBy[0]!).sql.toLowerCase()).toContain("desc")
	})

	it("throws sort_not_wired for a sort field with no supplied column, own or inherited, as buildListQuery does", () => {
		const ghost = parsed({ parsedSort: [{ direction: "asc", field: "ghost" }] })
		expect(() => buildDerivedListQuery({ ...SIGNED, ...base, parsed: ghost })).toThrow(
			expect.objectContaining({ errorKey: "sort_not_wired" }),
		)
		const inherited = Object.create({ ghost: base.idColumn }) as typeof base.sortColumns
		expect(() => buildDerivedListQuery({ ...SIGNED, ...base, parsed: ghost, sortColumns: inherited })).toThrow(
			expect.objectContaining({ errorKey: "sort_not_wired" }),
		)
	})
})

/** A cursor positioned at row d_9 with the given published_at, sorted in one direction */
const cursorFor = (value: unknown, direction: "asc" | "desc") =>
	createCursor({ id: "d_9", published_at: value }, [{ direction, field: "published_at" }], SIGNED)

describe("buildDerivedListQuery — cursor predicates across NULLs", () => {
	it("descending, non-null: walks strictly backwards with an id tiebreak", () => {
		const result = buildDerivedListQuery({
			...SIGNED,
			...base,
			parsed: parsed({ cursor: cursorFor(1700000000000, "desc") }),
		})
		const { params, sql } = compile(result.where!)
		expect(sql).toContain("<")
		expect(params).toContain("d_9")
	})

	it("descending, null cursor: stays in the NULL zone or crosses into non-NULLs", () => {
		const result = buildDerivedListQuery({ ...SIGNED, ...base, parsed: parsed({ cursor: cursorFor(null, "desc") }) })
		const { sql } = compile(result.where!)
		/* NULLS FIRST means the null zone leads; advancing leaves it via IS NOT NULL */
		expect(sql.toLowerCase()).toContain("is null")
		expect(sql.toLowerCase()).toContain("is not null")
	})

	it("ascending, null cursor: only advances within the trailing NULL zone", () => {
		const result = buildDerivedListQuery({
			...SIGNED,
			...base,
			parsed: parsed({ cursor: cursorFor(null, "asc"), parsedSort: [{ direction: "asc", field: "published_at" }] }),
		})
		const { sql } = compile(result.where!)
		expect(sql.toLowerCase()).toContain("is null")
		/* NULLS LAST means there is nothing after the null zone to cross into */
		expect(sql.toLowerCase()).not.toContain("is not null")
	})

	it("ascending, non-null: walks forwards and admits the trailing NULLs", () => {
		const result = buildDerivedListQuery({
			...SIGNED,
			...base,
			parsed: parsed({ cursor: cursorFor(5, "asc"), parsedSort: [{ direction: "asc", field: "published_at" }] }),
		})
		const { sql } = compile(result.where!)
		expect(sql).toContain(">")
		expect(sql.toLowerCase()).toContain("is null")
	})

	it("rejects a cursor encoded for the opposite direction", () => {
		/* encoded asc, queried desc — re-serving page one would duplicate rows */
		expect(() =>
			buildDerivedListQuery({ ...SIGNED, ...base, parsed: parsed({ cursor: cursorFor(5, "asc") }) }),
		).toThrow(CombError)
	})
})

describe("buildDerivedListQuery — clause combination", () => {
	it("returns undefined when there is nothing to filter on", () => {
		expect(buildDerivedListQuery({ ...SIGNED, ...base, parsed: parsed() }).where).toBeUndefined()
	})

	it("passes a single clause through unwrapped", () => {
		const filterWhere = compileSql("published_at > 1")
		const result = buildDerivedListQuery({ ...SIGNED, ...base, filterWhere, parsed: parsed() })
		expect(compile(result.where!).sql).not.toContain(" and ")
	})

	it("ands the base, filter and search clauses together", () => {
		const result = buildDerivedListQuery({
			...SIGNED,
			...base,
			baseWhere: compileSql("deleted_at is null"),
			filterWhere: compileSql("published_at > 1"),
			parsed: parsed(),
			searchWhere: compileSql("title like '%a%'"),
		})
		expect(compile(result.where!).sql.toLowerCase()).toContain(" and ")
	})

	it("accepts a baseWhere supplied as a callback", () => {
		const result = buildDerivedListQuery({
			...SIGNED,
			...base,
			baseWhere: (tag) => tag`deleted_at is null`,
			parsed: parsed(),
		})
		expect(result.where).toBeDefined()
	})
})

describe("buildDerivedListQuery — a sort key declared as time (Q4)", () => {
	const latest = compileSql("max(published_at)")
	const sort: Array<SortField<"latest">> = [{ direction: "desc", field: "latest" }]
	const timed = { idColumn: derived.id, sortColumns: { latest: { sql: latest, type: "date" as const } } }

	it("takes the Date a row minted and binds it as epoch milliseconds", () => {
		const cursor = createCursor({ id: "d_9", latest: new Date(1700000000000) }, sort, SIGNED)
		const built = buildDerivedListQuery({ ...SIGNED, ...timed, parsed: { cursor, limit: 20, parsedSort: sort } })
		const { params, sql } = compile(built.where as SQL)
		expect(sql).toContain("max(published_at)")
		expect(params).toContain(1700000000000)
	})

	it("refuses a number where the key declared a Date", () => {
		const cursor = createCursor({ id: "d_9", latest: 1700000000000 }, sort, SIGNED)
		expect(() =>
			buildDerivedListQuery({ ...SIGNED, ...timed, parsed: { cursor, limit: 20, parsedSort: sort } }),
		).toThrow(expect.objectContaining({ errorKey: "invalid_cursor" }))
	})
})
