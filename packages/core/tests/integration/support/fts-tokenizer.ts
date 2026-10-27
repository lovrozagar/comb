/**
 * The generator's FTS tokenizer on one engine (U32): `categories` arrived in SQLite 3.30, so each
 * engine comb targets must take it. A table is made with it, a pointed Hebrew word, a Devanagari
 * word and a Latin word with a diacritic are indexed, and each is found by the term a reader types,
 * a fragment a mark would split off not. No test framework is imported, so vitest and bun:test share it.
 */
import { DEFAULT_TOKENIZER } from "../../../src/codegen/generators/fts-sql.ts"

export const WORDS = ["שָׁלוֹם", "हिन्दी", "café"]

/** The statements that make the table and index WORDS, in order */
export const SETUP = [
	"CREATE TABLE doc (id INTEGER PRIMARY KEY, title TEXT NOT NULL)",
	`CREATE VIRTUAL TABLE doc_fts USING fts5(title, content='doc', content_rowid='id', tokenize='${DEFAULT_TOKENIZER.replaceAll("'", "''")}')`,
	...WORDS.map((word, i) => `INSERT INTO doc VALUES (${i + 1}, '${word}')`),
	"INSERT INTO doc_fts(doc_fts) VALUES ('rebuild')",
]

/** Each term, and the ids its prefix query must find */
export const MATCHES: ReadonlyArray<[string, number[]]> = [
	["שָׁלוֹם", [1]],
	["हिन्दी", [2]],
	["हु", []],
	["cafe", [3]],
]

/** The MATCH query of `term`, a prefix of one quoted phrase */
export const matchSql = (term: string) =>
	`SELECT rowid AS id FROM doc_fts WHERE doc_fts MATCH '"${term.replaceAll('"', '""')}"*' ORDER BY rowid`
