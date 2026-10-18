/**
 * A quote-aware reading of SQL text: code, strings, identifiers and comments. Every migration
 * step that splits, hashes, terminates or classifies SQL reads it through here, so `;`, `--` and
 * `/*` inside a string or identifier are always data. The dialect decides the lexer: SQLite quotes
 * identifiers with `"`, backticks or brackets and has flat comments; Postgres quotes them with `"`
 * only, nests comments, escapes with backslashes in `E'…'`, and dollar-quotes `$tag$…$tag$`.
 */
import type { Dialect } from "../types.ts"

/**
 * `body` is a dollar-quoted `DO` body: it runs during the migration, so it is code to classify,
 * yet one statement to split, while a function body (`literal`) is only defined.
 */
type Segment = { kind: "body" | "code" | "comment" | "identifier" | "literal"; text: string }

/** Opening quote → closing quote, by dialect */
const QUOTES: Readonly<Record<Dialect, Readonly<Record<string, string>>>> = {
	postgres: { '"': '"', "'": "'" },
	sqlite: { '"': '"', "'": "'", "[": "]", "`": "`" },
}

/** A dollar-quote tag at the start of the text: `$$` or `$name$`, a name never starting with a digit */
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/
/** A character an identifier continues with, so a `$` or an `E` after it starts nothing */
const IDENT_CHAR = /[\w$\u0080-\uffff]/
const DO_STATEMENT = /^\s*DO\b/i

type Lexer = { dialect: Dialect; sql: string }

/** Whether the text at `at` opens a backslash-escaped Postgres string: `E'` or `e'`, not part of a word */
const isEscapeString = ({ dialect, sql }: Lexer, at: number) =>
	dialect === "postgres" && /[Ee]/.test(sql[at - 1] ?? "") && !IDENT_CHAR.test(sql[at - 2] ?? "")

/** The end of the string or identifier opening at `at`: a doubled closing quote is an escaped one, except in [ ] */
function quotedEnd(lexer: Lexer, at: number): number {
	const { sql } = lexer
	const close = QUOTES[lexer.dialect][sql[at] as string] as string
	const backslash = close === "'" && isEscapeString(lexer, at)
	let i = at + 1
	while (i < sql.length) {
		if (backslash && sql[i] === "\\") i += 2
		else if (sql[i] === close && close !== "]" && sql[i + 1] === close) i += 2
		else if (sql[i] === close) return i + 1
		else i++
	}
	return sql.length
}

/** The end of the comment at `at`; Postgres block comments nest */
function commentEnd({ dialect, sql }: Lexer, at: number): number {
	if (sql.startsWith("--", at)) {
		const newline = sql.indexOf("\n", at)
		return newline === -1 ? sql.length : newline
	}
	let depth = 1
	let i = at + 2
	while (i < sql.length) {
		if (sql.startsWith("*/", i)) {
			depth--
			i += 2
			if (depth === 0) return i
		} else if (dialect === "postgres" && sql.startsWith("/*", i)) {
			depth++
			i += 2
		} else i++
	}
	return sql.length
}

/** The dollar-quote tag opening at `at`, or undefined: never inside an identifier or at `$1` */
function dollarTag({ dialect, sql }: Lexer, at: number): string | undefined {
	if (dialect !== "postgres" || sql[at] !== "$" || IDENT_CHAR.test(sql[at - 1] ?? "")) return undefined
	return DOLLAR_TAG.exec(sql.slice(at))?.[0]
}

/** The segment starting at `at`, given the code of the statement read so far */
function segmentAt(lexer: Lexer, at: number, statement: string): Segment {
	const { sql } = lexer
	const tag = dollarTag(lexer, at)
	if (tag !== undefined) {
		const close = sql.indexOf(tag, at + tag.length)
		const end = close === -1 ? sql.length : close + tag.length
		return { kind: DO_STATEMENT.test(statement) ? "body" : "literal", text: sql.slice(at, end) }
	}
	const quote = QUOTES[lexer.dialect][sql[at] as string]
	if (quote !== undefined) {
		const kind = sql[at] === "'" ? "literal" : "identifier"
		return { kind, text: sql.slice(at, quotedEnd(lexer, at)) }
	}
	if (sql.startsWith("--", at) || sql.startsWith("/*", at)) {
		return { kind: "comment", text: sql.slice(at, commentEnd(lexer, at)) }
	}
	let end = at + 1
	while (end < sql.length && !opensSpecial(lexer, end)) end++
	return { kind: "code", text: sql.slice(at, end) }
}

const opensSpecial = (lexer: Lexer, at: number) =>
	Object.hasOwn(QUOTES[lexer.dialect], lexer.sql[at] as string) ||
	lexer.sql.startsWith("--", at) ||
	lexer.sql.startsWith("/*", at) ||
	dollarTag(lexer, at) !== undefined

/** `sql` as consecutive segments that concatenate back to it, read as `dialect` reads it */
function segments(sql: string, dialect: Dialect = "sqlite"): Segment[] {
	const lexer: Lexer = { dialect, sql }
	const out: Segment[] = []
	/* the code since the last top-level ;, which tells a DO body from a function body */
	let statement = ""
	let i = 0
	while (i < sql.length) {
		const segment = segmentAt(lexer, i, statement)
		if (segment.kind === "code") statement = (statement + segment.text).split(";").at(-1) as string
		out.push(segment)
		i += segment.text.length
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
function splitSqlStatements(sql: string, dialect: Dialect = "sqlite"): string[] {
	const reading: Reading = { code: "", depth: 0, text: "" }
	const statements: string[] = []
	for (const segment of segments(sql, dialect)) {
		if (segment.kind === "code") statements.push(...readCode(reading, segment.text))
		else reading.text += segment.text
	}
	statements.push(finish(reading))
	return statements.filter((statement) => statement !== "")
}

/**
 * `sql` with comments dropped and whitespace collapsed outside strings and identifiers, those
 * verbatim: two migrations that differ only in layout or comments normalize alike, two that differ
 * in data or names never. A migration's hash is taken over this form.
 */
function normalizeSql(sql: string): string {
	let out = ""
	for (const segment of segments(sql)) {
		const text =
			segment.kind === "comment" ? " " : segment.kind === "code" ? segment.text.replace(/\s+/g, " ") : segment.text
		out += out.endsWith(" ") && text.startsWith(" ") ? text.slice(1) : text
	}
	return out.trim()
}

export { normalizeSql, segments, splitSqlStatements, type Segment }
