/**
 * Where a recorded statement's own verb starts: past leading comments and a WITH clause's common
 * table expressions, so `WITH gone AS (…) DELETE FROM t` and `/* note *\/ DELETE FROM t` both
 * read as the DELETE they are. Comments, literals, quoted names and parenthesized groups are
 * blanked before the verb is looked for, so no word inside them is taken for it.
 */
import { codeOf, joined } from "./sql-lexer.ts"

/** The closing index of the quote opened at `start`, a doubled quote standing for itself */
function closeQuote(sql: string, start: number, close: string): number {
	let i = start + 1
	while (i < sql.length && !(sql[i] === close && sql[i + 1] !== close)) i += sql[i] === close ? 2 : 1
	return i
}

/** The end (exclusive) of the comment, literal or quoted name at `i`, or i when there is none */
function skipped(sql: string, i: number): number {
	const two = sql.slice(i, i + 2)
	if (two === "--") {
		const end = sql.indexOf("\n", i)
		return end === -1 ? sql.length : end
	}
	if (two === "/*") {
		const end = sql.indexOf("*/", i + 2)
		return end === -1 ? sql.length : end + 2
	}
	const char = sql[i] as string
	if (char === "[") return sql.indexOf("]", i) === -1 ? sql.length : sql.indexOf("]", i) + 1
	return `'"\``.includes(char) ? closeQuote(sql, i, char) + 1 : i
}

/** `sql` at the same length, with everything that cannot hold its verb turned to spaces */
function blanked(sql: string): string {
	let out = ""
	let depth = 0
	for (let i = 0; i < sql.length;) {
		const end = skipped(sql, i)
		if (end > i) {
			out += " ".repeat(end - i)
			i = end
			continue
		}
		const char = sql[i] as string
		if (char === "(") depth++
		out += depth === 0 ? char : " "
		if (char === ")") depth--
		i++
	}
	return out
}

const VERB = /\b(?:insert|replace|update|delete|select)\b/i

/** `sql` from its main statement's verb on; `sql` itself, trimmed, when no verb is found */
export function statementHead(sql: string): string {
	const top = blanked(sql)
	const start = top.search(/\S/)
	if (start === -1) return ""
	const verb = /^with\b/i.test(top.slice(start)) ? top.slice(start).search(VERB) : 0
	return sql.slice(start + Math.max(verb, 0)).trim()
}

/* one part of a name: quoted whole, its doubled quotes standing for one, or bare. A string is a name
 * where SQLite takes one for it; Postgres's code reaches here with its strings blanked */
const PART = "\"(?:[^\"]|\"\")+\"|`(?:[^`]|``)+`|'(?:[^']|'')+'|\\[[^\\]]+\\]|[^\\s(.\"`'\\[,=;*]+"
// per-process-constant: one part, captured
const ONE_PART = /* @__PURE__ */ new RegExp(PART, "g")
// per-process-constant: a name, its schema parts before it, as a pattern
const NAME = `(?:(?:${PART})\\s*\\.\\s*)*(?:${PART})`

/* the table an INSERT, UPDATE or DELETE targets, from the SQL a wrapper recorded, read from the
 * statement's own verb on: a name its schema qualifies or not, each part quoted or bare. `target` is
 * how an UPDATE or DELETE names it: on Postgres past ONLY, a reserved word there that names no table
 * (AB7 of area B), or inside ONLY's parentheses; on SQLite, which has no ONLY, only names a table
 * (B2-10 of area B) */
const statementTables = (target: string) =>
	new RegExp(
		`^(?:(?:insert\\s+(?:or\\s+\\w+\\s+)?into|replace\\s+into)\\s+(${NAME})|(?:update(?:\\s+or\\s+\\w+)?|delete\\s+from)${target})`,
		"i",
	)
// per-process-constant: see above
const STATEMENT_TABLE = {
	postgres: /* @__PURE__ */ statementTables(`(?:\\s+only\\s*\\(\\s*(${NAME})\\s*\\)|(?:\\s+only\\b)?\\s+(${NAME}))`),
	sqlite: /* @__PURE__ */ statementTables(`\\s+(${NAME})`),
}

/** One name part as `dialect` resolves it: unquoted, and a bare one with its ASCII letters lowered on Postgres */
function unquoted(part: string, dialect: "postgres" | "sqlite"): string {
	if (part.startsWith('"')) return part.slice(1, -1).replaceAll('""', '"')
	if (part.startsWith("`")) return part.slice(1, -1).replaceAll("``", "`")
	if (part.startsWith("'")) return part.slice(1, -1).replaceAll("''", "'")
	if (part.startsWith("[")) return part.slice(1, -1)
	return dialect === "postgres" ? part.replace(/[A-Z]+/g, (upper) => upper.toLowerCase()) : part
}

/**
 * The table `query` writes to in `dialect`, or undefined when no wrapper recorded the SQL or it writes
 * none: the table and the schema written before it, if any, each unquoted, read as `dialect` reads
 * the statement, so a comment is space, a quoted name a token of its own, and a bare name folded as
 * Postgres folds it. SQLite keys its maps by
 * the table alone; Postgres resolves both to a map key as every other violation does
 */
export function statementTable(
	query: string | undefined,
	dialect: "postgres" | "sqlite",
): { schema: string | undefined; table: string } | undefined {
	/* U8, QE8 of r22b, B2-10b and AB3-8 of area B; SQLite's code keeps its strings, which name a table there */
	const code = dialect === "sqlite" ? joined(query ?? "", dialect, true) : codeOf(query ?? "", dialect)
	const name = STATEMENT_TABLE[dialect]
		.exec(statementHead(code))
		?.slice(1)
		.find((group) => group !== undefined)
	if (name === undefined) return undefined
	const parts = (name.match(ONE_PART) as string[]).map((part) => unquoted(part, dialect))
	return { schema: parts.at(-2), table: parts.at(-1) as string }
}

// per-process-constant: an UPDATE up to its SET list, past an alias and an INDEXED BY or NOT INDEXED
const UPDATE_SET = /* @__PURE__ */ new RegExp(
	`^update(?:\\s+or\\s+\\w+)?\\s+${NAME}(?:\\s+(?:as\\s+)?\\w+)?(?:\\s+indexed\\s+by\\s+(?:${PART})|\\s+not\\s+indexed)?\\s+set\\s+`,
	"i",
)
// per-process-constant: the head of one assignment: a column, or a parenthesized list of them, before its `=`
const ASSIGNED = /* @__PURE__ */ new RegExp(`^\\s*(?:\\(([^)]*)\\)|(${PART}))\\s*=`)

/** The raw pieces of `list` between its top-level commas: none inside a literal, a quoted name or a group */
function topLevelPieces(list: string): string[] {
	const top = blanked(list)
	const pieces: string[] = []
	let start = 0
	for (let i = 0; i < top.length; i++) {
		if (top[i] !== ",") continue
		pieces.push(list.slice(start, i))
		start = i + 1
	}
	return [...pieces, list.slice(start)]
}

/**
 * The columns a SQLite UPDATE's SET list assigns, unquoted, its list read up to a top-level WHERE,
 * FROM or RETURNING: each assignment's head, one column or a row value's list of them; undefined
 * when `query` is no UPDATE
 */
export function updatedColumns(query: string | undefined): string[] | undefined {
	const head = statementHead(query ?? "")
	const set = UPDATE_SET.exec(head)
	if (set === null) return undefined
	return assignedIn(head.slice(set[0].length), /\b(?:where|from|returning)\b/i)
}

// per-process-constant: an INSERT or REPLACE up to its target table's end
const INSERT_INTO = /* @__PURE__ */ new RegExp(`^(?:insert\\s+(?:or\\s+\\w+\\s+)?into|replace\\s+into)\\s+${NAME}`, "i")

/** The index of the `)` that closes the group opened at `open`, past literals and quoted names; the end when none does */
function groupEnd(sql: string, open: number): number {
	let depth = 0
	for (let i = open; i < sql.length;) {
		const end = skipped(sql, i)
		if (end > i) {
			i = end
			continue
		}
		if (sql[i] === "(") depth++
		if (sql[i] === ")" && --depth === 0) return i
		i++
	}
	return sql.length
}

/**
 * The columns an INSERT's column list names, unquoted; undefined when `query` is no INSERT or names
 * no list, which assigns every column (AB4 of area B). The list follows the table and its alias, if
 * any, in parentheses
 */
export function insertedColumns(query: string | undefined): string[] | undefined {
	const head = statementHead(query ?? "")
	const into = INSERT_INTO.exec(head)
	if (into === null) return undefined
	const rest = head.slice(into[0].length)
	const open = /^\s*(?:as\s+\w+\s*)?\(/i.exec(rest)
	if (open === null) return undefined
	const list = rest.slice(open[0].length, groupEnd(rest, open[0].length - 1))
	return topLevelPieces(list)
		.flatMap((piece) => piece.trim().match(ONE_PART) ?? [])
		.map((part) => unquoted(part, "sqlite"))
}

/** The columns a SET list assigns, unquoted, the list read up to the first top-level match of `end` */
function assignedIn(list: string, end: RegExp): string[] {
	const stop = blanked(list).search(end)
	return topLevelPieces(stop === -1 ? list : list.slice(0, stop)).flatMap((piece) => {
		const [, many, one] = ASSIGNED.exec(piece) ?? []
		if (one !== undefined) return [unquoted(one, "sqlite")]
		return many === undefined ? [] : (many.match(ONE_PART) ?? []).map((part) => unquoted(part, "sqlite"))
	})
}

/**
 * The columns an upsert's DO UPDATE SET lists assign, unquoted, each list read up to a top-level
 * WHERE, RETURNING or next ON CONFLICT; undefined when `query` is no INSERT or has none (U43)
 */
export function upsertColumns(query: string | undefined): string[] | undefined {
	/* matched on the blanked head, where a quoted name is spaces: the match ends at SET, so none is swallowed */
	const head = statementHead(query ?? "")
	if (!/^(?:insert|replace)\b/i.test(head)) return undefined
	const sets = [...blanked(head).matchAll(/\bdo\s+update\s+set\b/gi)]
	if (sets.length === 0) return undefined
	return sets.flatMap((set) =>
		assignedIn(head.slice(set.index + set[0].length), /\b(?:where|returning|on\s+conflict)\b/i),
	)
}
