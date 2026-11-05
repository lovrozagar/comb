/**
 * FTS5 + spellfix search helpers for SQLite. User text is bound, never spliced: each term becomes
 * a quoted prefix phrase (`"term"*`), in which FTS5 reads no syntax, and identifiers go through quoteIdent.
 */
import { type SQL, sql } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"

import { errorTexts } from "../../error-chain.ts"
import { quoteIdent } from "./identifier.ts"
import { searchText } from "./search-text.ts"

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
 * `<fts table> MATCH ?`, every term required as a prefix; null for an empty query, no row for one
 * only FTS syntax spells
 */
function buildFtsMatch(
	ftsTableName: string,
	query: string | null,
	{
		folded = false,
	}: {
		/** true when the FTS table indexes a searchText column: each term is folded as the column was; default false */
		folded?: boolean | undefined
	} = {},
): SQL | null {
	const terms = ftsTerms(query, folded)
	return terms.length === 0 ? termless(query) : sql`${ident(ftsTableName)} MATCH ${matchQuery(terms, "AND")}`
}

/**
 * A table and the FTS5 table that indexes it by rowid (external content, `content_rowid` its
 * rowid or its integer key)
 */
export type FtsSource = {
	// U16
	/**
	 * The FTS table indexes a searchText column (`_search`): each term is folded with searchText as
	 * the column was, so ß, æ, a ligature or a Greek accent typed as written finds it
	 */
	folded?: boolean | undefined
	/** the FTS5 table's name */
	ftsTable: string
	/** the table it indexes */
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
function buildFtsHighlight(
	ftsTableName: string,
	columnIndex: number,
	tags: {
		/** the text after each match */
		end: string
		/** the text before each match */
		start: string
	},
): SQL {
	return sql`highlight(${ident(ftsTableName)}, ${columnIndex}, ${tags.start}, ${tags.end})`
}

/** A row of a spellfix1 vocabulary query */
export type SpellfixRow = {
	/** a word the vocabulary offers */
	word: string
}

/** The database `buildFtsWhereWithSpellfix` asks for corrections: a drizzle SQLite database */
type SpellfixDb = {
	/** runs a query and resolves to its rows */
	all: (query: SQL) => Promise<Array<SpellfixRow>>
	/** the client drizzle's wrapper holds (d1, libsql, bun:sqlite), which keys the spellfix1 probe */
	$client?: unknown
}

/** An FTS search whose terms are widened by a spellfix1 vocabulary's corrections */
type SpellfixSearch = FtsSource & {
	/** editdist3 bound below which a word counts as a correction (default 300) */
	maxEditDistance?: number | undefined
	/** corrections taken per term (default 3) */
	maxCorrections?: number | undefined
	// Q4 of r20, Q3 of r21
	/** false where spellfix1 is never loaded: the terms are searched as typed and nothing is probed; a D1 client is known without it */
	spellfix?: boolean | undefined
	/** the spellfix1 vocabulary table's name */
	spellfixTable: string
}

/* SQLite's words for a function no extension registered: spellfix1 registers editdist3 */
const NO_EDITDIST3 = /\bno such function: editdist3\b/

// lookup-table: whether each database client has spellfix1 loaded, asked once, a failure to ask never kept
const LOADED: WeakMap<object, Promise<boolean>> = /* @__PURE__ */ new WeakMap()

/** What a probe's answer is kept under: the client a drizzle wrapper holds, so a wrapper per request asks once (Q4 of r20), else `db` */
const clientOf = (db: SpellfixDb): object => (typeof db.$client === "object" && db.$client !== null ? db.$client : db)

/**
 * Whether `client` is D1's, a D1Database (`withSession`) or a session of one (`getBookmark`), the
 * duck test openD1Session makes: D1 loads no extension, and openD1Session makes a session per
 * request, which no probe kept per client would ever answer (Q3 of r21)
 */
const isD1 = (client: object): boolean =>
	typeof (client as { withSession?: unknown }).withSession === "function" ||
	typeof (client as { getBookmark?: unknown }).getBookmark === "function"

/**
 * Whether `db` has spellfix1 loaded, asked once per client before any spellfix query: editdist3,
 * the function it registers, reads no table, so its absence is never a misspelled vocabulary
 * table (K1 of r19). D1 is answered unasked (Q3 of r21). Any other failure is thrown.
 */
function spellfixLoaded(db: SpellfixDb): Promise<boolean> {
	const key = clientOf(db)
	if (isD1(key)) return Promise.resolve(false)
	const known = LOADED.get(key)
	if (known !== undefined) return known
	/* in an async function, so a driver that throws as it prepares (drizzle's bun:sqlite) rejects as the others do */
	const asked = (async () => db.all(sql`SELECT editdist3('a', 'b') AS d`))().then(
		() => true,
		(error: unknown) => {
			LOADED.delete(key)
			if (errorTexts(error).some((text) => NO_EDITDIST3.test(text))) {
				LOADED.set(key, Promise.resolve(false))
				return false
			}
			throw error
		},
	)
	LOADED.set(key, asked)
	return asked
}

/**
 * Words spellfix1 offers for `term`. Any failure, a vocabulary table misspelled or a transient D1
 * error, is the caller's to see (K9 of r18): spellfixLoaded said the extension is there
 */
async function corrections(db: SpellfixDb, term: string, search: SpellfixSearch): Promise<string[]> {
	const { maxCorrections = 3, maxEditDistance = 300, spellfixTable } = search
	const rows = await db.all(
		sql`SELECT word FROM ${ident(spellfixTable)} WHERE word MATCH ${`${term}*`} AND editdist3(word, ${term}) < ${maxEditDistance} LIMIT ${maxCorrections}`,
	)
	return rows.map((row) => row.word).filter(Boolean)
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
	/* without spellfix1 the terms are searched as typed (README §Search) */
	const loaded = search.spellfix !== false && terms.some((term) => term.length >= 3) && (await spellfixLoaded(db))
	const groups: string[] = []
	for (const term of terms) {
		const found = loaded && term.length >= 3 ? await corrections(db, term, search) : []
		const variants = [...new Set([term, ...found].map((variant) => variant.toLowerCase()))]
		groups.push(variants.length === 1 ? matchQuery(variants, "OR") : `(${matchQuery(variants, "OR")})`)
	}
	return inMatches(search, groups.join(" AND "))
}

/** A search: the `q` text in, its WHERE clause out; null when it searches nothing */
type LikeSearchResolver = (q: string) => SQL | null

// U21, QE2 of r22b
/**
 * The search of a `_search` column that searchText wrote, or any other SQL expression. Each
 * whitespace-separated term is folded by searchText and trimmed, and kept only when it holds a letter
 * or digit, as FTS keeps its terms: a mark alone folds to nothing or a space, and would match every
 * row. Each term is found with `instr` in the expression's `lower()`, so no LIKE pattern is built and
 * none meets D1's 50-byte pattern cap, and any expression is matched ignoring ASCII case; only a
 * searchText column matches its accents and other folds. Every term is required. A query whose terms
 * all fold away matches no row, as FTS answers it.
 */
function likeSearch(column: SQLiteColumn | SQL): LikeSearchResolver {
	return (q) => {
		const terms = q
			.split(/\s+/u)
			.map((term) => searchText(term).trim())
			.filter((term) => TOKEN.test(term))
		const clauses = terms.map((term) => sql`instr(lower(${column}), ${term}) > 0`)
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
	type SpellfixDb,
	type SpellfixSearch,
}
