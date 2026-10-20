/**
 * FTS5 search helpers against SQLite's real query parser: every term is a prefix query, and
 * user text with quotes or FTS syntax reaches it as plain words.
 */
import { eq, type SQL, sql } from "drizzle-orm"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import { buildFtsMatch, buildFtsWhere } from "../../../src/query/sqlite/search.ts"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"

const open: LibsqlHarness[] = []
afterEach(() => {
	for (const harness of open.splice(0)) harness.close()
})

const doc = sqliteTable("doc", { title: text("title").notNull() })

const TITLES = ["post", "postgres tips", "posture", "o'reilly books", 'say "hi" twice', "unrelated"]

async function indexed() {
	const harness = libsqlMemory()
	open.push(harness)
	await harness.client.executeMultiple(`
CREATE TABLE doc (title TEXT NOT NULL);
CREATE VIRTUAL TABLE doc_fts USING fts5(title, content='doc', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER doc_fts_ai AFTER INSERT ON doc BEGIN INSERT INTO doc_fts(rowid, title) VALUES (new.rowid, new.title); END;
`)
	for (const title of TITLES) await harness.client.execute({ args: [title], sql: "INSERT INTO doc (title) VALUES (?)" })
	return harness.db
}

/** The titles a search finds, through buildFtsWhere on the source table */
async function found(query: string): Promise<string[]> {
	const db = await indexed()
	const where = buildFtsWhere({ ftsTable: "doc_fts", table: doc }, query)
	if (!where) return []
	const rows = await db.all<{ title: string }>(sql`SELECT title FROM doc WHERE ${where} ORDER BY rowid`)
	return rows.map((row) => row.title)
}

describe("FTS terms are prefix queries (S-3)", () => {
	it("finds every word that starts with the term", async () => {
		expect(await found("post")).toEqual(["post", "postgres tips", "posture"])
		expect(await found("pos tip")).toEqual(["postgres tips"])
	})

	it("matches through buildFtsMatch on the FTS table too", async () => {
		const db = await indexed()
		const match = buildFtsMatch("doc_fts", "postg")
		const rows = await db.all<{ title: string }>(sql`SELECT title FROM doc_fts WHERE ${match}`)
		expect(rows.map((row) => row.title)).toEqual(["postgres tips"])
	})
})

describe("user text reaches FTS5 as words, never as syntax", () => {
	it.each([
		["o'reilly", ["o'reilly books"]],
		['"hi"', ['say "hi" twice']],
		["say hi", ['say "hi" twice']],
		['post"', ["post", "postgres tips", "posture"]],
		/* each of these would widen or redirect the search if FTS5 read it as syntax */
		["post OR unrelated", []],
		["title:post", []],
		["NEAR(post unrelated)", []],
		["post*", ["post", "postgres tips", "posture"]],
	])("%s", async (query, expected) => {
		expect(await found(query)).toEqual(expected)
	})
})

describe("control characters in user text (S-M9)", () => {
	it("searches past a NUL or other control character instead of failing in FTS5's parser", async () => {
		expect(await found("post\u0000gres")).toEqual(["postgres tips"])
		expect(await found("\u0001post")).toEqual(["post", "postgres tips", "posture"])
	})
})

/* a table whose key is a text id, as comb's c.id() makes it, joined to another, and indexed by rowid */
const note = sqliteTable("note", { author: text("author"), id: text("id").primaryKey(), title: text("title") })
const author = sqliteTable("author", { id: text("id").primaryKey(), name: text("name") })

describe("FTS on a table with a text id, in a joined query (B5)", () => {
	it("finds only the matching rows, with no column the join makes ambiguous", async () => {
		const harness = libsqlMemory()
		open.push(harness)
		await harness.client.executeMultiple(`
CREATE TABLE author (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE note (id TEXT PRIMARY KEY, author TEXT, title TEXT);
CREATE VIRTUAL TABLE note_fts USING fts5(title, content='note', content_rowid='rowid');
CREATE TRIGGER note_fts_ai AFTER INSERT ON note BEGIN INSERT INTO note_fts(rowid, title) VALUES (new.rowid, new.title); END;
INSERT INTO author VALUES ('a1', 'Ada');
INSERT INTO note VALUES ('n1', 'a1', 'postgres tips'), ('n2', 'a1', 'unrelated');
`)
		const where = buildFtsWhere({ ftsTable: "note_fts", table: note }, "postgres")
		const rows = await harness.db
			.select({ id: note.id, name: author.name })
			.from(note)
			.innerJoin(author, eq(author.id, note.author))
			.where(where as SQL)
		expect(rows).toEqual([{ id: "n1", name: "Ada" }])
	})
})
