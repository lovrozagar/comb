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
} from "../../../../src/query/sqlite/search.ts"

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

	it("returns null for empty string", () => {
		expect(search("")).toBeNull()
	})

	it("returns null for whitespace-only input", () => {
		expect(search("   ")).toBeNull()
	})

	it("returns SQL for valid input", () => {
		const result = search("hello")
		expect(result).toBeTruthy()
	})

	it("normalizes diacritics", () => {
		const result = search("José")
		expect(result).toBeTruthy()
		/* normalized: "jose" — diacritics stripped, lowercased */
	})

	it("lowercases input", () => {
		const result = search("HELLO")
		expect(result).toBeTruthy()
	})

	it("escapes LIKE special: %", () => {
		const result = search("100%")
		expect(result).toBeTruthy()
	})

	it("escapes LIKE special: _", () => {
		const result = search("foo_bar")
		expect(result).toBeTruthy()
	})

	it("escapes LIKE special: backslash", () => {
		const result = search("path\\file")
		expect(result).toBeTruthy()
	})

	it("trims leading/trailing whitespace", () => {
		const result = search("  hello  ")
		expect(result).toBeTruthy()
	})
})

describe("sanitizeFtsTerm", () => {
	it("strips FTS special characters", () => {
		expect(sanitizeFtsTerm("test*")).toBe("test")
		expect(sanitizeFtsTerm("he(llo)")).toBe("hello")
		expect(sanitizeFtsTerm("col:on")).toBe("colon")
	})

	it("escapes double quotes", () => {
		expect(sanitizeFtsTerm('say"hi')).toBe('say""hi')
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

	it("returns SQL for valid query", () => {
		const result = buildFtsMatch("fts_table", "hello")
		expect(result).toBeTruthy()
	})

	it("returns null when all terms are boolean keywords", () => {
		expect(buildFtsMatch("fts_table", "AND OR NOT")).toBeNull()
	})

	it("handles multi-word queries", () => {
		const result = buildFtsMatch("fts_table", "hello world")
		expect(result).toBeTruthy()
	})
})

describe("buildFtsWhere", () => {
	it("returns null for empty query", () => {
		expect(buildFtsWhere("fts_table", "id", null)).toBeNull()
		expect(buildFtsWhere("fts_table", "id", "")).toBeNull()
	})

	it("returns SQL for valid query", () => {
		const result = buildFtsWhere("fts_table", "id", "search term")
		expect(result).toBeTruthy()
	})
})

describe("buildFtsHighlight", () => {
	it("builds a highlight() call around the requested column index", () => {
		const built = buildFtsHighlight("item_fts", 1, "<mark>", "</mark>")
		expect(compile(built).sql).toBe("highlight(item_fts, 1, '<mark>', '</mark>')")
	})

	it("escapes single quotes in the tags so they cannot close the literal", () => {
		const built = buildFtsHighlight("item_fts", 0, "<b class='hit'>", "</b>")
		const { sql } = compile(built)
		expect(sql).toContain("'<b class=''hit''>'")
		/* the literal must still be balanced */
		expect(sql.split("'").length % 2).toBe(1)
	})
})

describe("buildFtsWhereWithSpellfix", () => {
	const spellfixDb = (rows: Array<{ word: string }>) => ({ all: async () => rows })

	it("returns null for empty or whitespace-only input", async () => {
		expect(await buildFtsWhereWithSpellfix(spellfixDb([]), "f", "s", "id", null)).toBeNull()
		expect(await buildFtsWhereWithSpellfix(spellfixDb([]), "f", "s", "id", "   ")).toBeNull()
	})

	it("returns null when every term sanitises away", async () => {
		expect(await buildFtsWhereWithSpellfix(spellfixDb([]), "f", "s", "id", "AND OR")).toBeNull()
	})

	it("ORs the corrections in alongside the original term", async () => {
		const built = await buildFtsWhereWithSpellfix(spellfixDb([{ word: "hello" }]), "item_fts", "sp", "id", "helo")
		const { params } = compile(built!)
		expect(String(params[0])).toContain('"helo*"')
		expect(String(params[0])).toContain('"hello*"')
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
		await buildFtsWhereWithSpellfix(db, "item_fts", "sp", "id", "ab")
		expect(called).toBe(0)
	})

	it("drops a correction identical to the term, case-insensitively", async () => {
		const built = await buildFtsWhereWithSpellfix(spellfixDb([{ word: "hello" }]), "item_fts", "sp", "id", "Hello")
		const { params } = compile(built!)
		expect(String(params[0])).toBe('"hello*"')
	})

	it("degrades to the plain term when the spellfix table is missing", async () => {
		const db = {
			all: async () => {
				throw new Error("no such table: spellfix")
			},
		}
		const built = await buildFtsWhereWithSpellfix(db, "item_fts", "sp", "id", "hello")
		expect(built).not.toBeNull()
		expect(String(compile(built!).params[0])).toBe('"hello*"')
	})

	it("binds the MATCH query rather than inlining it", async () => {
		const built = await buildFtsWhereWithSpellfix(spellfixDb([]), "item_fts", "sp", "id", "hello")
		const { params, sql } = compile(built!)
		expect(sql).not.toContain("hello")
		expect(params).toContain('"hello*"')
	})
})
