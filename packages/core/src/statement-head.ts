/**
 * Where a recorded statement's own verb starts: past leading comments and a WITH clause's common
 * table expressions, so `WITH gone AS (…) DELETE FROM t` and `/* note *\/ DELETE FROM t` both
 * read as the DELETE they are. Comments, literals, quoted names and parenthesized groups are
 * blanked before the verb is looked for, so no word inside them is taken for it.
 */

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

/* one part of a name: quoted whole, its doubled quotes standing for one, or bare */
const PART = '"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[[^\\]]+\\]|[^\\s(."`\\[,=]+'
// per-process-constant: one part, captured
const ONE_PART = /* @__PURE__ */ new RegExp(PART, "g")
// per-process-constant: a name, its schema parts before it, as a pattern
const NAME = `(?:(?:${PART})\\s*\\.\\s*)*(?:${PART})`

/* the table an INSERT, UPDATE or DELETE targets, from the SQL a wrapper recorded, read from the
 * statement's own verb on: a name its schema qualifies or not, each part quoted or bare */
// per-process-constant: see above
const STATEMENT_TABLE = /* @__PURE__ */ new RegExp(
	`^(?:insert\\s+(?:or\\s+\\w+\\s+)?into|replace\\s+into|update(?:\\s+or\\s+\\w+)?|delete\\s+from)\\s+(${NAME})`,
	"i",
)

/** One name part as written, unquoted */
function unquoted(part: string): string {
	if (part.startsWith('"')) return part.slice(1, -1).replaceAll('""', '"')
	if (part.startsWith("`")) return part.slice(1, -1).replaceAll("``", "`")
	return part.startsWith("[") ? part.slice(1, -1) : part
}

/**
 * The table `query` writes to, or undefined when no wrapper recorded the SQL or it writes none: the
 * table itself, not its schema, as the constraint maps and the engines' errors name it (U8)
 */
export function statementTable(query: string | undefined): string | undefined {
	const name = STATEMENT_TABLE.exec(statementHead(query ?? ""))?.[1]
	return name === undefined ? undefined : unquoted(name.match(ONE_PART)?.at(-1) as string)
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
 * The columns an UPDATE's SET list assigns, unquoted, its list read up to a top-level WHERE, FROM
 * or RETURNING: each assignment's head, one column or a row value's list of them; undefined when
 * `query` is no UPDATE
 */
export function updatedColumns(query: string | undefined): string[] | undefined {
	const head = statementHead(query ?? "")
	const set = UPDATE_SET.exec(head)
	if (set === null) return undefined
	const list = head.slice(set[0].length)
	const end = blanked(list).search(/\b(?:where|from|returning)\b/i)
	return topLevelPieces(end === -1 ? list : list.slice(0, end)).flatMap((piece) => {
		const [, many, one] = ASSIGNED.exec(piece) ?? []
		if (one !== undefined) return [unquoted(one)]
		return many === undefined ? [] : (many.match(ONE_PART) ?? []).map(unquoted)
	})
}
