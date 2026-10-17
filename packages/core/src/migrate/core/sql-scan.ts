/**
 * A quote-aware reading of SQL text: code, string or identifier literals, and comments. Every
 * migration step that splits, hashes or terminates SQL reads it through here, so `;`, `--` and
 * `/*` inside a literal are always data.
 */

type Segment = { kind: "code" | "comment" | "literal"; text: string }

/** Opening quote → closing quote: strings, double-quoted, backtick and bracket identifiers */
const QUOTES: Readonly<Record<string, string>> = { '"': '"', "'": "'", "[": "]", "`": "`" }

const opensSpecial = (sql: string, at: number) =>
	Object.hasOwn(QUOTES, sql[at] as string) || sql.startsWith("--", at) || sql.startsWith("/*", at)

/** The end of the literal opening at `at`: a doubled closing quote is an escaped one, except in [ ] */
function literalEnd(sql: string, at: number): number {
	const close = QUOTES[sql[at] as string] as string
	let i = at + 1
	while (i < sql.length) {
		if (sql[i] === close && close !== "]" && sql[i + 1] === close) i += 2
		else if (sql[i] === close) return i + 1
		else i++
	}
	return sql.length
}

function commentEnd(sql: string, at: number): number {
	if (sql.startsWith("--", at)) {
		const newline = sql.indexOf("\n", at)
		return newline === -1 ? sql.length : newline
	}
	const close = sql.indexOf("*/", at + 2)
	return close === -1 ? sql.length : close + 2
}

/** `sql` as consecutive segments that concatenate back to it */
function segments(sql: string): Segment[] {
	const out: Segment[] = []
	let i = 0
	while (i < sql.length) {
		let end: number
		let kind: Segment["kind"]
		if (Object.hasOwn(QUOTES, sql[i] as string)) {
			end = literalEnd(sql, i)
			kind = "literal"
		} else if (sql.startsWith("--", i) || sql.startsWith("/*", i)) {
			end = commentEnd(sql, i)
			kind = "comment"
		} else {
			end = i + 1
			while (end < sql.length && !opensSpecial(sql, end)) end++
			kind = "code"
		}
		out.push({ kind, text: sql.slice(i, end) })
		i = end
	}
	return out
}

const TRIGGER = /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i
const BLOCK_WORDS = /\b(BEGIN|CASE|END)\b|;/gi

/** The statement being read: its text, its code alone, and how deep inside BEGIN/CASE … END it is */
type Reading = { code: string; depth: number; text: string }

/** Append one code segment, splitting at each `;` outside a trigger body; returns finished statements */
function readCode(reading: Reading, text: string): string[] {
	const done: string[] = []
	let from = 0
	for (const match of text.matchAll(BLOCK_WORDS)) {
		const at = match.index
		const word = match[1]?.toUpperCase()
		reading.code += text.slice(from, at + match[0].length)
		reading.text += text.slice(from, at + (word ? match[0].length : 0))
		from = at + match[0].length
		if (word === "BEGIN" && (reading.depth > 0 || TRIGGER.test(reading.code))) reading.depth++
		else if (word === "CASE" && reading.depth > 0) reading.depth++
		else if (word === "END" && reading.depth > 0) reading.depth--
		else if (!word && reading.depth === 0) done.push(finish(reading))
		else if (!word) reading.text += ";"
	}
	reading.code += text.slice(from)
	reading.text += text.slice(from)
	return done
}

/** The statement read so far, reset for the next; empty when it held no code */
function finish(reading: Reading): string {
	const statement = reading.code.replace(/;/g, "").trim() === "" ? "" : reading.text.trim()
	reading.code = ""
	reading.text = ""
	return statement
}

/**
 * The statements of `sql`, without their terminating `;`. A `;` ends a statement only in code:
 * never inside a literal or a comment, nor inside a trigger's BEGIN … END. A stretch that holds
 * only comments is not a statement.
 */
function splitSqlStatements(sql: string): string[] {
	const reading: Reading = { code: "", depth: 0, text: "" }
	const statements: string[] = []
	for (const segment of segments(sql)) {
		if (segment.kind === "code") statements.push(...readCode(reading, segment.text))
		else reading.text += segment.text
	}
	statements.push(finish(reading))
	return statements.filter((statement) => statement !== "")
}

/**
 * `sql` with comments dropped and whitespace collapsed outside literals, literals verbatim: two
 * migrations that differ only in layout or comments normalize alike, two that differ in data never.
 */
function normalizeSql(sql: string): string {
	let out = ""
	for (const segment of segments(sql)) {
		const text =
			segment.kind === "literal" ? segment.text : segment.kind === "comment" ? " " : segment.text.replace(/\s+/g, " ")
		out += out.endsWith(" ") && text.startsWith(" ") ? text.slice(1) : text
	}
	return out.trim()
}

export { normalizeSql, segments, splitSqlStatements, type Segment }
