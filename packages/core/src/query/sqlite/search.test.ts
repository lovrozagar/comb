import type { SQL } from "drizzle-orm"
import { SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import {
	buildFtsHighlight,
	buildFtsMatch,
	buildFtsWhere,
	buildFtsWhereWithSpellfix,
	likeSearch,
	sanitizeFtsTerm,
} from "./search.ts"

const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()
const compile = (built: SQL) => dialect.sqlToQuery(built)

const item = sqliteTable("item", {
	_search: text("_search").notNull(),
	id: text("id").primaryKey(),
	name: text("name").notNull(),
})

describe("likeSearch", () => {
	const search = likeSearch(item._search)
	const bound = (q: string) => {
		const built = search(q)
		return built && compile(built)
	}

	it("returns null for empty or whitespace-only input", () => {
		expect(search("")).toBeNull()
		expect(search("   ")).toBeNull()
	})

	it("binds one contains pattern per term, ANDed, against the escape character", () => {
		expect(bound("  hello  ")).toEqual({ params: ["%hello%"], sql: `"item"."_search" LIKE ? ESCAPE '\\'` })
		expect(bound("a b")?.sql).toBe(`"item"."_search" LIKE ? ESCAPE '\\' AND "item"."_search" LIKE ? ESCAPE '\\'`)
	})

	it("folds diacritics and case the way the _search column stores them", () => {
		expect(bound("José HELLO")?.params).toEqual(["%jose%", "%hello%"])
	})

	it("escapes the LIKE specials so they match themselves", () => {
		expect(bound("100% foo_bar path\\file")?.params).toEqual(["%100\\%%", "%foo\\_bar%", "%path\\\\file%"])
	})
})

describe("sanitizeFtsTerm", () => {
	it("strips FTS special characters", () => {
		expect(sanitizeFtsTerm("test*")).toBe("test")
		expect(sanitizeFtsTerm("he(llo)")).toBe("hello")
		expect(sanitizeFtsTerm("col:on")).toBe("colon")
	})

	it("keeps double quotes for the phrase builder to escape", () => {
		expect(sanitizeFtsTerm('say"hi')).toBe('say"hi')
	})

	it("returns empty for boolean keywords", () => {
		expect(sanitizeFtsTerm("AND")).toBe("")
		expect(sanitizeFtsTerm("OR")).toBe("")
		expect(sanitizeFtsTerm("NOT")).toBe("")
		expect(sanitizeFtsTerm("and")).toBe("")
	})

	it("preserves normal terms", () => {
		expect(sanitizeFtsTerm("hello")).toBe("hello")
		expect(sanitizeFtsTerm("café")).toBe("café")
	})
})

describe("buildFtsMatch", () => {
	it("returns null for empty query", () => {
		expect(buildFtsMatch("fts_table", null)).toBeNull()
		expect(buildFtsMatch("fts_table", "")).toBeNull()
		expect(buildFtsMatch("fts_table", "  ")).toBeNull()
	})

	it("binds every term as a quoted prefix phrase on the quoted table (S-3)", () => {
		const { params, sql } = compile(buildFtsMatch("fts_table", 'hello say"hi') as SQL)
		expect(sql).toBe('"fts_table" MATCH ?')
		expect(params).toEqual(['"hello"* AND "say""hi"*'])
	})

	it("returns null when all terms are boolean keywords", () => {
		expect(buildFtsMatch("fts_table", "AND OR NOT")).toBeNull()
	})
})

describe("buildFtsWhere", () => {
	it("returns null for empty query", () => {
		expect(buildFtsWhere("fts_table", "id", null)).toBeNull()
		expect(buildFtsWhere("fts_table", "id", "")).toBeNull()
	})

	it("selects the matching ids through the FTS table, the query bound", () => {
		const { params, sql } = compile(buildFtsWhere("fts_table", "id", "search term") as SQL)
		expect(sql).toBe('"id" IN (SELECT "id" FROM "fts_table" WHERE "fts_table" MATCH ?)')
		expect(params).toEqual(['"search"* AND "term"*'])
	})
})

describe("buildFtsHighlight", () => {
	it("builds a highlight() call with the column index and tags bound", () => {
		const { params, sql } = compile(buildFtsHighlight("item_fts", 1, { end: "</b>", start: "<b class='hit'>" }))
		expect(sql).toBe('highlight("item_fts", ?, ?, ?)')
		expect(params).toEqual([1, "<b class='hit'>", "</b>"])
	})
})

describe("buildFtsWhereWithSpellfix", () => {
	const spellfixDb = (rows: Array<{ word: string }>) => ({ all: async () => rows })

	it("returns null for empty or whitespace-only input", async () => {
		expect(
			await buildFtsWhereWithSpellfix(spellfixDb([]), { ftsTable: "f", idColumn: "id", spellfixTable: "s" }, null),
		).toBeNull()
		expect(
			await buildFtsWhereWithSpellfix(spellfixDb([]), { ftsTable: "f", idColumn: "id", spellfixTable: "s" }, "   "),
		).toBeNull()
	})

	it("returns null when every term sanitises away", async () => {
		expect(
			await buildFtsWhereWithSpellfix(spellfixDb([]), { ftsTable: "f", idColumn: "id", spellfixTable: "s" }, "AND OR"),
		).toBeNull()
	})

	it("ORs the corrections in alongside the original term", async () => {
		const built = await buildFtsWhereWithSpellfix(
			spellfixDb([{ word: "hello" }]),
			{ ftsTable: "item_fts", idColumn: "id", spellfixTable: "sp" },
			"helo",
		)
		const { params } = compile(built!)
		expect(String(params[0])).toContain('"helo"*')
		expect(String(params[0])).toContain('"hello"*')
		expect(String(params[0])).toContain(" OR ")
	})

	it("skips the spellfix lookup for terms shorter than three characters", async () => {
		let called = 0
		const db = {
			all: async () => {
				called++
				return []
			},
		}
		await buildFtsWhereWithSpellfix(db, { ftsTable: "item_fts", idColumn: "id", spellfixTable: "sp" }, "ab")
		expect(called).toBe(0)
	})

	it("drops a correction identical to the term, case-insensitively", async () => {
		const built = await buildFtsWhereWithSpellfix(
			spellfixDb([{ word: "hello" }]),
			{ ftsTable: "item_fts", idColumn: "id", spellfixTable: "sp" },
			"Hello",
		)
		const { params } = compile(built!)
		expect(String(params[0])).toBe('"hello"*')
	})

	it("degrades to the plain term when the spellfix table is missing", async () => {
		const db = {
			all: async () => {
				throw new Error("no such table: spellfix")
			},
		}
		const built = await buildFtsWhereWithSpellfix(
			db,
			{ ftsTable: "item_fts", idColumn: "id", spellfixTable: "sp" },
			"hello",
		)
		expect(built).not.toBeNull()
		expect(String(compile(built!).params[0])).toBe('"hello"*')
	})

	it("binds the term to spellfix as typed, with no escaping a bound value does not need (S-4)", async () => {
		const seen: unknown[][] = []
		const db = { all: async (query: SQL) => (seen.push(compile(query).params), []) }
		await buildFtsWhereWithSpellfix(db, { ftsTable: "item_fts", idColumn: "id", spellfixTable: "sp" }, "o'reilly")
		expect(seen).toEqual([["o'reilly*", "o'reilly", 300, 3]])
	})

	it("binds the MATCH query rather than inlining it", async () => {
		const built = await buildFtsWhereWithSpellfix(
			spellfixDb([]),
			{ ftsTable: "item_fts", idColumn: "id", spellfixTable: "sp" },
			"hello",
		)
		const { params, sql } = compile(built!)
		expect(sql).not.toContain("hello")
		expect(params).toContain('"hello"*')
	})
})
