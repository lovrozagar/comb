/**
 * FTS5 + spellfix search helpers for SQLite. User text is bound, never spliced: each term becomes
 * a quoted prefix phrase (`"term"*`), and identifiers go through quoteIdent.
 */
import { type SQL, sql } from "drizzle-orm"
import type { SQLiteColumn } from "drizzle-orm/sqlite-core"

import { quoteIdent } from "./identifier.ts"

const FTS_SYNTAX = /[*^:(){}[\]]/g

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

/** `<fts table> MATCH ?`, every term required; null when the query has no usable term */
function buildFtsMatch(ftsTableName: string, query: string | null): SQL | null {
	const terms = ftsTerms(query)
	return terms.length === 0 ? null : sql`${ident(ftsTableName)} MATCH ${matchQuery(terms, "AND")}`
}

/** `<id> IN (SELECT <id> FROM <fts table> WHERE … MATCH ?)` over a single-name id column */
function inMatches(ftsTableName: string, idColumn: string, query: string): SQL {
	const id = ident(idColumn)
	const table = ident(ftsTableName)
	return sql`${id} IN (SELECT ${id} FROM ${table} WHERE ${table} MATCH ${query})`
}

/** The rows whose FTS entry matches every term; null when the query has no usable term */
function buildFtsWhere(ftsTableName: string, idColumn: string, query: string | null): SQL | null {
	const terms = ftsTerms(query)
	return terms.length === 0 ? null : inMatches(ftsTableName, idColumn, matchQuery(terms, "AND"))
}

/** `highlight()` of one FTS column, its marker tags bound */
function buildFtsHighlight(ftsTableName: string, columnIndex: number, startTag: string, endTag: string): SQL {
	return sql`highlight(${ident(ftsTableName)}, ${columnIndex}, ${startTag}, ${endTag})`
}

type SpellfixRow = { word: string }

type SpellfixDb = {
	all: (query: SQL) => Promise<Array<SpellfixRow>>
}

type SpellfixSearch = {
	ftsTable: string
	idColumn: string
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
 * corrections; any variant of any term matches.
 */
async function buildFtsWhereWithSpellfix(
	db: SpellfixDb,
	search: SpellfixSearch,
	query: string | null,
): Promise<SQL | null> {
	const terms = ftsTerms(query)
	if (terms.length === 0) return null
	const variants: string[] = []
	for (const term of terms) {
		variants.push(term)
		if (term.length >= 3) variants.push(...(await corrections(db, term, search)))
	}
	const unique = [...new Set(variants.map((variant) => variant.toLowerCase()))]
	return inMatches(search.ftsTable, search.idColumn, matchQuery(unique, "OR"))
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
				const normalized = term.normalize("NFD").replace(DIACRITICS, "").toLowerCase()
				return normalized.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
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
