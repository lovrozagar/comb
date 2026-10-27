import { type SQL, sql as drizzleSql } from "drizzle-orm"
import { integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import {
	buildFtsHighlight,
	buildFtsMatch,
	buildFtsWhere,
	buildFtsWhereWithSpellfix,
	likeSearch,
	sanitizeFtsTerm,
	searchText,
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

	/* U21: instr finds a folded term with no LIKE pattern, so no term meets D1's 50-byte pattern cap */
	it("binds one instr per term, ANDed", () => {
		expect(bound("  hello  ")).toEqual({ params: ["hello"], sql: `instr("item"."_search", ?) > 0` })
		expect(bound("a b")?.sql).toBe(`instr("item"."_search", ?) > 0 AND instr("item"."_search", ?) > 0`)
	})

	it("folds diacritics and case the way the _search column stores them", () => {
		expect(bound("José HELLO")?.params).toEqual(["jose", "hello"])
	})

	it("binds LIKE's specials as they are, since instr reads no pattern", () => {
		expect(bound("100% foo_bar path\\file")?.params).toEqual(["100%", "foo_bar", "path\\file"])
	})
})

describe("searchText: the _search column's writer, which likeSearch reads with (Q14)", () => {
	/* U31: vowel points and tatweel are optional and not typed, as Latin accents are */
	it("drops Hebrew niqqud and cantillation, Arabic harakat and tatweel, keeping the letters", () => {
		expect(searchText("שָׁלוֹם")).toBe(searchText("שלום"))
		expect(searchText("مُحَمَّد")).toBe("محمد")
		expect(searchText("مـحـمـد")).toBe("محمد")
		expect(searchText("الْقُرْآن")).toBe(searchText("القرآن"))
	})

	it("folds case, diacritics and compatibility forms, and joins the parts it is given", () => {
		expect(searchText("Évaluation", null, "Crème Brûlée", undefined)).toBe("evaluation creme brulee")
		expect(searchText("ＦＩＬＥ ﬁx")).toBe("file fix")
		expect(searchText()).toBe("")
	})

	it("folds the Latin letters NFKD leaves whole to their ASCII spelling, and keeps other scripts", () => {
		expect(searchText("Straße ẞ Æon Œuvre Øre Łódź Đurđevac Ðór Þing ıi ĸ ŋ ŧ ħ")).toBe(
			"strasse ss aeon oeuvre ore lodz durdevac dor thing ii k n t h",
		)
		expect(searchText("日本語 Ελλάδα Москва")).toBe("日本語 ελλαδα москва")
	})

	it("is what likeSearch applies to each term, so a row written by it is found by any spelling", () => {
		const written = searchText("Crème Brûlée")
		for (const q of ["brûlée", "BRULEE", "Crème"]) {
			const term = (compile(likeSearch(item._search)(q) as SQL).params[0] as string).slice(1, -1)
			expect(written).toContain(term)
		}
	})
})

describe("likeSearch on a raw expression (C7)", () => {
	it("takes an SQL expression as well as a column", () => {
		const built = likeSearch(drizzleSql.raw('"_search"'))("hi")
		expect(compile(built as SQL)).toEqual({ params: ["hi"], sql: `instr("_search", ?) > 0` })
	})
})

describe("sanitizeFtsTerm", () => {
	it("keeps FTS5 syntax characters, which its quoted phrase reads as text (Q11)", () => {
		expect(sanitizeFtsTerm("test*")).toBe("test*")
		expect(sanitizeFtsTerm("f(x)")).toBe("f(x)")
		expect(sanitizeFtsTerm("error:timeout")).toBe("error:timeout")
	})

	it("keeps double quotes for the phrase builder to escape", () => {
		expect(sanitizeFtsTerm('say"hi')).toBe('say"hi')
	})

	it("keeps the words AND, OR and NOT, which a quoted phrase searches as words (Q11)", () => {
		for (const word of ["AND", "or", "Not"]) expect(sanitizeFtsTerm(word)).toBe(word)
	})

	it("drops control characters, and a term left with no letter or digit, which no token matches", () => {
		expect(sanitizeFtsTerm("post\u0000gres\u007f")).toBe("postgres")
		for (const term of ["***", "::", "-", "\u0001"]) expect(sanitizeFtsTerm(term)).toBe("")
	})

	it("preserves normal terms", () => {
		expect(sanitizeFtsTerm("hello")).toBe("hello")
		expect(sanitizeFtsTerm("café")).toBe("café")
		expect(sanitizeFtsTerm("東京")).toBe("東京")
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

	it("matches nothing when every term sanitizes away (Q-S3)", () => {
		for (const q of ["*", "::", "*** -"]) expect(compile(buildFtsMatch("fts_table", q) as SQL).sql).toBe("0")
	})
})

describe("buildFtsWhere", () => {
	it("returns null for empty query", () => {
		expect(buildFtsWhere({ ftsTable: "fts_table", table: item }, null)).toBeNull()
		expect(buildFtsWhere({ ftsTable: "fts_table", table: item }, "")).toBeNull()
	})

	it("matches nothing when every term sanitizes away (Q-S3)", () => {
		expect(compile(buildFtsWhere({ ftsTable: "fts_table", table: item }, "** ::") as SQL).sql).toBe("0")
	})

	it("selects the matching rows by the table's own rowid through the FTS table, the query bound", () => {
		const { params, sql } = compile(buildFtsWhere({ ftsTable: "fts_table", table: item }, "search term") as SQL)
		expect(sql).toBe('"item".rowid IN (SELECT rowid FROM "fts_table" WHERE "fts_table" MATCH ?)')
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

/** A spellfix database stub that answers every lookup with the given rows */
const spellfixDb = (rows: Array<{ word: string }>) => ({ all: async () => rows })

describe("buildFtsWhereWithSpellfix", () => {
	it("returns null for empty or whitespace-only input", async () => {
		expect(
			await buildFtsWhereWithSpellfix(spellfixDb([]), { ftsTable: "f", table: item, spellfixTable: "s" }, null),
		).toBeNull()
		expect(
			await buildFtsWhereWithSpellfix(spellfixDb([]), { ftsTable: "f", table: item, spellfixTable: "s" }, "   "),
		).toBeNull()
	})

	it("matches nothing when every term sanitizes away (Q-S3)", async () => {
		const built = await buildFtsWhereWithSpellfix(
			spellfixDb([]),
			{ ftsTable: "f", table: item, spellfixTable: "s" },
			"** ::",
		)
		expect(compile(built as SQL).sql).toBe("0")
	})

	it("requires every term, each matched by itself or one of its corrections (Q-D5)", async () => {
		const built = await buildFtsWhereWithSpellfix(
			spellfixDb([{ word: "rad" }, { word: "RED" }]),
			{ ftsTable: "item_fts", table: item, spellfixTable: "sp" },
			"red shoes",
		)
		expect(compile(built as SQL).params).toEqual(['("red"* OR "rad"*) AND ("shoes"* OR "rad"* OR "red"*)'])
	})

	it("ORs the corrections in alongside the original term", async () => {
		const built = await buildFtsWhereWithSpellfix(
			spellfixDb([{ word: "hello" }]),
			{ ftsTable: "item_fts", table: item, spellfixTable: "sp" },
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
		await buildFtsWhereWithSpellfix(db, { ftsTable: "item_fts", table: item, spellfixTable: "sp" }, "ab")
		expect(called).toBe(0)
	})
})

describe("buildFtsWhereWithSpellfix — corrections, fallback and binding", () => {
	it("drops a correction identical to the term, case-insensitively", async () => {
		const built = await buildFtsWhereWithSpellfix(
			spellfixDb([{ word: "hello" }]),
			{ ftsTable: "item_fts", table: item, spellfixTable: "sp" },
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
			{ ftsTable: "item_fts", table: item, spellfixTable: "sp" },
			"hello",
		)
		expect(built).not.toBeNull()
		expect(String(compile(built!).params[0])).toBe('"hello"*')
	})

	it("binds the term to spellfix as typed, with no escaping a bound value does not need (S-4)", async () => {
		const seen: unknown[][] = []
		const db = { all: async (query: SQL) => (seen.push(compile(query).params), []) }
		await buildFtsWhereWithSpellfix(db, { ftsTable: "item_fts", table: item, spellfixTable: "sp" }, "o'reilly")
		expect(seen).toEqual([["o'reilly*", "o'reilly", 300, 3]])
	})

	it("binds the MATCH query rather than inlining it", async () => {
		const built = await buildFtsWhereWithSpellfix(
			spellfixDb([]),
			{ ftsTable: "item_fts", table: item, spellfixTable: "sp" },
			"hello",
		)
		const { params, sql } = compile(built!)
		expect(sql).not.toContain("hello")
		expect(params).toContain('"hello"*')
	})
})

/* U16 of the 0.12 round: an FTS table over a searchText column takes its terms folded as the column was */
const foldedPost = sqliteTable("post", { id: integer("id").primaryKey() })

/** The FTS match buildFtsWhere binds for "Straße Οδυσσέας", folded or not */
const foldedMatch = (folded?: boolean) =>
	new SQLiteDialect().sqlToQuery(
		buildFtsWhere({ folded, ftsTable: "post_fts", table: foldedPost }, "Straße Οδυσσέας") as SQL,
	).params

describe("buildFtsWhere on a folded source", () => {
	it("folds each term with searchText, so a term typed with ß, æ or a Greek accent finds the folded text", () => {
		/* searchText writes a final ς as σ, as it folds the column */
		expect(foldedMatch(true)).toEqual(['"strasse"* AND "οδυσσεασ"*'])
		expect(foldedMatch()).toEqual(['"Straße"* AND "Οδυσσέας"*'])
	})
})
