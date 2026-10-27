/**
 * FTS5 + spellfix search helpers for SQLite. User text is bound, never spliced: each term becomes
 * a quoted prefix phrase (`"term"*`), in which FTS5 reads no syntax, and identifiers go through quoteIdent.
 */
import { type SQL, sql } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"

import { quoteIdent } from "./identifier.ts"

/* control characters: a NUL ends the C string FTS5 parses, mid-phrase */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/g

/* a token unicode61 indexes: a term with none of these matches no row, and would empty the search */
const TOKEN = /[\p{L}\p{N}]/u

/**
 * A search term as its quoted phrase searches it: every word and character kept, as FTS5 reads
 * none of them as syntax inside the quotes, control characters removed. "" when no letter or digit
 * is left, as no token matches it. Quotes stay: the phrase builder escapes them where it quotes the term.
 */
function sanitizeFtsTerm(term: string): string {
	const sanitized = term.replace(CONTROL, "").trim()
	return TOKEN.test(sanitized) ? sanitized : ""
}

/** The usable terms of a search string, each folded with searchText when the FTS table indexes a folded column */
function ftsTerms(query: string | null, folded = false): string[] {
	if (!query) return []
	return query
		.trim()
		.split(/\s+/)
		.map((term) => sanitizeFtsTerm(folded ? searchText(term) : term))
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

/**
 * `<fts table> MATCH ?`, every term required; null for an empty query, no row for one only FTS
 * syntax spells. `folded` when the FTS table indexes a searchText column: each term is folded so
 */
function buildFtsMatch(
	ftsTableName: string,
	query: string | null,
	{ folded = false }: { folded?: boolean | undefined } = {},
): SQL | null {
	const terms = ftsTerms(query, folded)
	return terms.length === 0 ? termless(query) : sql`${ident(ftsTableName)} MATCH ${matchQuery(terms, "AND")}`
}

/**
 * A table and the FTS5 table that indexes it by rowid (external content, `content_rowid` its
 * rowid or its integer key)
 */
type FtsSource = {
	/**
	 * The FTS table indexes a searchText column (`_search`): each term is folded with searchText as
	 * the column was, so ß, æ, a ligature or a Greek accent typed as written finds it (U16)
	 */
	folded?: boolean | undefined
	ftsTable: string
	table: SQLiteTable
}

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
	const terms = ftsTerms(query, source.folded)
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
	const terms = ftsTerms(query, search.folded)
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

/* a run of the combining marks NFKD splits off a letter (é is e + U+0301), with the letter before it when that letter is Cyrillic */
const MARKS = /(\p{Script=Cyrillic})?([\u0300-\u036f]+)/gu

/**
 * `text` without its combining marks, but those that make a Cyrillic letter of its own (й is и +
 * U+0306, ї is і + U+0308): a mark stays only where NFC puts it back into one letter with the one
 * before it, so a stress mark (а́, which no letter holds) goes, as FTS5's unicode61 drops it (U7)
 */
const unmarked = (text: string): string =>
	text.replace(MARKS, (_run, letter: string | undefined, marks: string) =>
		letter === undefined
			? ""
			: letter + [...marks].filter((mark) => [...`${letter}${mark}`.normalize("NFC")].length === 1).join(""),
	)

/* the Latin letters NFKD leaves whole, each with the ASCII a reader types for it (ẞ, Æ, … lowercase to these first) */
const LATIN_FOLD: Readonly<Record<string, string>> = {
	ð: "d",
	ß: "ss",
	æ: "ae",
	ø: "o",
	þ: "th",
	đ: "d",
	ħ: "h",
	ı: "i",
	ĸ: "k",
	ł: "l",
	ŋ: "n",
	œ: "oe",
	ŧ: "t",
}
const LATIN_LETTERS = /[ðßæøþđħıĸłŋœŧ]/g

/**
 * The text a `_search` column stores for `parts`, and what likeSearch folds each term to: the
 * present parts joined by a space, compatibility forms folded (ＦＩＬＥ, ﬁ), lowercased, Greek final
 * sigma ς as σ (so a letter folds the same wherever it stands), combining marks removed but those
 * that make a Cyrillic letter (й, ї, ё), the Latin letters with no decomposition spelled in ASCII
 * (ß ss, æ ae, œ oe, ø o, ł l, đ and ð d, þ th, ı i, ĸ k, ŋ n, ŧ t, ħ h), then composed again (NFC),
 * so й and Hangul syllables stay whole. Write the column with it, so the reader and the writer
 * are one function.
 */
function searchText(...parts: Array<string | null | undefined>): string {
	const lowered = parts
		.filter((part): part is string => typeof part === "string" && part !== "")
		.join(" ")
		.normalize("NFKD")
		.toLowerCase()
		/* toLowerCase writes Σ as ς at a word end and σ inside one: one letter, whatever its place */
		.replace(/ς/g, "σ")
	return (
		unmarked(lowered)
			.replace(LATIN_LETTERS, (letter) => LATIN_FOLD[letter] as string)
			/* what kept its marks, and Hangul's jamo, composed back: й, ї and 가 as they were written */
			.normalize("NFC")
	)
}

/**
 * Factory for LIKE-based search on a `_search` column that searchText wrote, or any SQL expression
 * that holds such text. Each whitespace-separated term is folded by searchText and trimmed, and
 * kept only when it holds a letter or digit, as FTS keeps its terms: a mark alone folds to nothing
 * or a space, and would match every row. Each term is found with `instr`, both sides already
 * folded, so no LIKE pattern is built and none meets D1's 50-byte pattern cap (U21); every term is
 * required. A query whose terms all fold away matches no row, as FTS answers it.
 */
function likeSearch(column: SQLiteColumn | SQL): LikeSearchResolver {
	return (q) => {
		const terms = q
			.split(/\s+/u)
			.map((term) => searchText(term).trim())
			.filter((term) => TOKEN.test(term))
		const clauses = terms.map((term) => sql`instr(${column}, ${term}) > 0`)
		return clauses.length === 0 ? termless(q) : sql.join(clauses, sql` AND `)
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
	searchText,
	type SpellfixDb,
	type SpellfixSearch,
}
