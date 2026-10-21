/**
 * FTS5 + spellfix search helpers for SQLite. User text is bound, never spliced: each term becomes
 * a quoted prefix phrase (`"term"*`), and identifiers go through quoteIdent.
 */
import { type SQL, sql } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"

import { escapeLike } from "../like.ts"
import { quoteIdent } from "./identifier.ts"

/* FTS5 syntax, and control characters: a NUL ends the C string FTS5 parses, mid-phrase */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const FTS_SYNTAX = /[*^:(){}[\]\u0000-\u001f\u007f]/g

// lookup-table: FTS5's boolean operators, which a bare search term must never become
const OPERATORS = /* @__PURE__ */ new Set(["AND", "NOT", "OR"])

/**
 * A search term with FTS5 syntax characters removed, or "" when nothing is left or it is a bare
 * boolean operator. Quotes stay: the phrase builder escapes them where it quotes the term.
 */
function sanitizeFtsTerm(term: string): string {
	const sanitized = term.replace(FTS_SYNTAX, "").trim()
	return OPERATORS.has(sanitized.toUpperCase()) ? "" : sanitized
}

/** The usable terms of a search string */
function ftsTerms(query: string | null): string[] {
	if (!query) return []
	return query
		.trim()
		.split(/\s+/)
		.map(sanitizeFtsTerm)
		.filter((term) => term.length > 0)
}

/** One term as an FTS5 prefix query: a quoted phrase with `*` after the closing quote */
const prefixPhrase = (term: string) => `"${term.replaceAll('"', '""')}"*`

const matchQuery = (terms: readonly string[], joiner: "AND" | "OR") => terms.map(prefixPhrase).join(` ${joiner} `)

const ident = (name: string) => sql.raw(quoteIdent(name))

/**
 * What a query with no usable term searches for: nothing when it asked for nothing (null, so the
 * list is not searched), and no row when it asked for something only FTS syntax spells
 */
const termless = (query: string | null): SQL | null => (query === null || query.trim() === "" ? null : sql`0`)

/** `<fts table> MATCH ?`, every term required; null for an empty query, no row for one only FTS syntax spells */
function buildFtsMatch(ftsTableName: string, query: string | null): SQL | null {
	const terms = ftsTerms(query)
	return terms.length === 0 ? termless(query) : sql`${ident(ftsTableName)} MATCH ${matchQuery(terms, "AND")}`
}

/**
 * A table and the FTS5 table that indexes it by rowid (external content, `content_rowid` its
 * rowid or its integer key)
 */
type FtsSource = { ftsTable: string; table: SQLiteTable }

/**
 * `<table>.rowid IN (SELECT rowid FROM <fts> WHERE <fts> MATCH ?)`: the rowid qualified by its
 * table, so a join cannot make it ambiguous and a text id column never stands in for it
 */
function inMatches({ ftsTable, table }: FtsSource, query: string): SQL {
	const fts = ident(ftsTable)
	return sql`${table}.rowid IN (SELECT rowid FROM ${fts} WHERE ${fts} MATCH ${query})`
}

/**
 * The rows of `source.table` whose FTS entry matches every term; null for an empty query, no row
 * for one only FTS syntax spells
 */
function buildFtsWhere(source: FtsSource, query: string | null): SQL | null {
	const terms = ftsTerms(query)
	return terms.length === 0 ? termless(query) : inMatches(source, matchQuery(terms, "AND"))
}

/** `highlight()` of one FTS column, its marker tags bound */
function buildFtsHighlight(ftsTableName: string, columnIndex: number, tags: { end: string; start: string }): SQL {
	return sql`highlight(${ident(ftsTableName)}, ${columnIndex}, ${tags.start}, ${tags.end})`
}

type SpellfixRow = { word: string }

type SpellfixDb = {
	all: (query: SQL) => Promise<Array<SpellfixRow>>
}

type SpellfixSearch = FtsSource & {
	/** editdist3 bound below which a word counts as a correction (default 300) */
	maxEditDistance?: number
	/** corrections taken per term (default 3) */
	maxCorrections?: number
	spellfixTable: string
}

/** Words spellfix1 offers for `term`; none when the extension or its table is unavailable */
async function corrections(db: SpellfixDb, term: string, search: SpellfixSearch): Promise<string[]> {
	const { maxCorrections = 3, maxEditDistance = 300, spellfixTable } = search
	try {
		const rows = await db.all(
			sql`SELECT word FROM ${ident(spellfixTable)} WHERE word MATCH ${`${term}*`} AND editdist3(word, ${term}) < ${maxEditDistance} LIMIT ${maxCorrections}`,
		)
		return rows.map((row) => row.word).filter(Boolean)
	} catch {
		// reason: spellfix1 is an optional extension; without it the search runs on the terms as typed
		return []
	}
}

/**
 * Like buildFtsWhere, with each term of three or more characters widened by its spellfix1
 * corrections: every term is required, each matched by itself or any of its corrections.
 */
async function buildFtsWhereWithSpellfix(
	db: SpellfixDb,
	search: SpellfixSearch,
	query: string | null,
): Promise<SQL | null> {
	const terms = ftsTerms(query)
	if (terms.length === 0) return termless(query)
	const groups: string[] = []
	for (const term of terms) {
		const found = term.length >= 3 ? await corrections(db, term, search) : []
		const variants = [...new Set([term, ...found].map((variant) => variant.toLowerCase()))]
		groups.push(variants.length === 1 ? matchQuery(variants, "OR") : `(${matchQuery(variants, "OR")})`)
	}
	return inMatches(search, groups.join(" AND "))
}

/**
 * Resolver that converts a raw search string into a LIKE WHERE clause.
 * Returns null when input is empty — callers can skip the clause entirely.
 */
type LikeSearchResolver = (q: string) => SQL | null

const DIACRITICS = /[\u0300-\u036f]/g

/**
 * Factory for LIKE-based search on a pre-normalized `_search` column.
 * Strips diacritics, lowercases, escapes LIKE specials (`%`, `_`, `\`).
 * Multi-word queries split on unicode whitespace — each term ANDed separately.
 */
function likeSearch(column: SQLiteColumn): LikeSearchResolver {
	return (q) => {
		const terms = q
			.split(/\s+/u)
			.filter((term) => term.length > 0)
			.map((term) => {
				return escapeLike(term.normalize("NFD").replace(DIACRITICS, "").toLowerCase())
			})
		const clauses = terms.map((term) => sql`${column} LIKE ${`%${term}%`} ESCAPE '\\'`)
		return clauses.length === 0 ? null : sql.join(clauses, sql` AND `)
	}
}

export {
	buildFtsHighlight,
	buildFtsMatch,
	buildFtsWhere,
	buildFtsWhereWithSpellfix,
	likeSearch,
	type LikeSearchResolver,
	sanitizeFtsTerm,
	type SpellfixDb,
	type SpellfixSearch,
}
