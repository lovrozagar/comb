/**
 * FTS5 + spellfix search helpers for SQLite.
 * Security: ftsQuery values are parameterized via sql``, not interpolated into sql.raw().
 */
import { type SQL, sql } from "drizzle-orm"
import type { SQLiteColumn } from "drizzle-orm/sqlite-core"

function sanitizeFtsTerm(term: string): string {
	const sanitized = term
		.replace(/[*^:(){}[\]]/g, "")
		.replace(/"/g, '""')
		.trim()

	const upper = sanitized.toUpperCase()
	if (upper === "AND" || upper === "OR" || upper === "NOT") {
		return ""
	}

	return sanitized
}

/**
 * Build FTS MATCH expression with parameterized query value.
 * Table/column identifiers use sql.raw() (safe — not user input).
 * The MATCH query string is bound as a parameter.
 */
function buildFtsMatch(ftsTableName: string, query: string | null): SQL | null {
	if (!query || query.trim() === "") {
		return null
	}

	const terms = query
		.trim()
		.split(/\s+/)
		.map((term) => sanitizeFtsTerm(term))
		.filter((term) => term.length > 0)

	if (terms.length === 0) {
		return null
	}

	const ftsQuery = terms.map((term) => `"${term}*"`).join(" AND ")
	const tableRef = sql.raw(ftsTableName)

	return sql`${tableRef} MATCH ${ftsQuery}`
}

/**
 * Build FTS WHERE subquery with parameterized MATCH value.
 */
function buildFtsWhere(ftsTableName: string, idColumn: string, query: string | null): SQL | null {
	if (!query || query.trim() === "") {
		return null
	}

	const terms = query
		.trim()
		.split(/\s+/)
		.map((term) => sanitizeFtsTerm(term))
		.filter((term) => term.length > 0)

	if (terms.length === 0) {
		return null
	}

	const ftsQuery = terms.map((term) => `"${term}*"`).join(" AND ")
	const tableRef = sql.raw(ftsTableName)
	const idRef = sql.raw(idColumn)

	return sql`${idRef} IN (SELECT ${idRef} FROM ${tableRef} WHERE ${tableRef} MATCH ${ftsQuery})`
}

function buildFtsHighlight(ftsTableName: string, columnIndex: number, startTag: string, endTag: string): SQL {
	return sql.raw(
		`highlight(${ftsTableName}, ${columnIndex}, '${startTag.replace(/'/g, "''")}', '${endTag.replace(/'/g, "''")}')`,
	)
}

type SpellfixRow = { word: string }

type SpellfixDb = {
	all: (query: SQL) => Promise<Array<SpellfixRow>>
}

async function buildFtsWhereWithSpellfix(
	db: SpellfixDb,
	ftsTableName: string,
	spellfixTableName: string,
	idColumn: string,
	query: string | null,
	maxEditDistance = 300,
	maxCorrections = 3,
): Promise<SQL | null> {
	if (!query || query.trim() === "") {
		return null
	}

	const terms = query
		.trim()
		.split(/\s+/)
		.map((term) => sanitizeFtsTerm(term))
		.filter((term) => term.length > 0)

	if (terms.length === 0) {
		return null
	}

	const allTerms: string[] = []

	for (const term of terms) {
		allTerms.push(term)

		if (term.length < 3) {
			continue
		}

		try {
			const spellfixRef = sql.raw(spellfixTableName)
			const escapedTerm = term.replace(/'/g, "''")
			const corrections = await db.all(
				sql`SELECT word FROM ${spellfixRef} WHERE word MATCH ${`${escapedTerm}*`} AND editdist3(word, ${escapedTerm}) < ${maxEditDistance} LIMIT ${maxCorrections}`,
			)

			for (const row of corrections) {
				if (row.word && row.word !== term.toLowerCase()) {
					allTerms.push(row.word)
				}
			}
		} catch {
			/* Spellfix query failed, continue without corrections */
		}
	}

	const uniqueTerms = Array.from(new Set(allTerms.map((t) => t.toLowerCase())))
	const ftsQuery = uniqueTerms.map((t) => `"${t}*"`).join(" OR ")

	const tableRef = sql.raw(ftsTableName)
	const idRef = sql.raw(idColumn)

	return sql`${idRef} IN (SELECT ${idRef} FROM ${tableRef} WHERE ${tableRef} MATCH ${ftsQuery})`
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
		const trimmed = q.trim()
		if (!trimmed) return null

		const terms = trimmed
			.split(/\s+/u)
			.filter((t) => t.length > 0)
			.map((t) => {
				const normalized = t.normalize("NFD").replace(DIACRITICS, "").toLowerCase()
				return normalized.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
			})

		if (terms.length === 0) return null

		if (terms.length === 1) {
			return sql`${column} LIKE ${`%${terms[0]}%`} ESCAPE '\\'`
		}

		const clauses = terms.map((term) => sql`${column} LIKE ${`%${term}%`} ESCAPE '\\'`)
		return clauses.reduce((acc, clause) => sql`${acc} AND ${clause}`)
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
}
