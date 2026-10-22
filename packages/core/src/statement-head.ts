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

/* the table an INSERT, UPDATE or DELETE targets, from the SQL a wrapper recorded, read from the
 * statement's own verb on: a quoted name whole, its doubled quotes undone, or a bare one */
const STATEMENT_TABLE =
	/^(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+(?:"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|\[([^\]]+)\]|([^\s(]+))/i
/** The table `query` writes to, or undefined when no wrapper recorded the SQL or it writes none */
export function statementTable(query: string | undefined): string | undefined {
	const [, double, back, bracket, bare] = STATEMENT_TABLE.exec(statementHead(query ?? "")) ?? []
	return double?.replaceAll('""', '"') ?? back?.replaceAll("``", "`") ?? bracket ?? bare
}
