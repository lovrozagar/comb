/**
 * A quote-aware reading of SQL text: code, strings, identifiers and comments. Every migration
 * step that splits, hashes, terminates or classifies SQL, and each error handler that reads a
 * failed statement's table, reads it through here, so `;`, `--` and `/*` inside a string or
 * identifier are always data. The dialect decides the lexer: SQLite quotes
 * identifiers with `"`, backticks or brackets and has flat comments; Postgres quotes them with `"`
 * only, nests comments, escapes with backslashes in `E'…'`, and dollar-quotes `$tag$…$tag$`.
 */
import type { Dialect } from "./migrate/types.ts"

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

/* a character SQLite reads into a bare word: a letter, digit, _, $, or any above ASCII */
const WORD_CHAR: RegExp = /[\w$\u0080-\uffff]/

/* a body's tag as bodyText reads it: any text between two dollars */
const BODY_TAG = /^\$[^$]*\$/

/** A dollar-quoted body without its tags */
function bodyText(text: string): string {
	const tag = BODY_TAG.exec(text)?.[0] as string
	return text.endsWith(tag) && text.length >= 2 * tag.length
		? text.slice(tag.length, -tag.length)
		: text.slice(tag.length)
}

/**
 * `stmt`'s segments joined: identifiers kept, a DO body read as code itself, comments one space, strings kept or one
 * space. A quoted name is a token of its own, so a word written against it is set off by a space, as `ALTER TABLE
 * "users"DROP COLUMN email` drops the column `ALTER TABLE "users" DROP COLUMN email` does; `"main".t` and `"a"(` stay
 */
function joined(stmt: string, dialect: Dialect, strings: boolean): string {
	let out = ""
	let quoted = false
	for (const { kind, text } of segments(stmt, dialect)) {
		const kept = kind === "code" || kind === "identifier" || (strings && kind === "literal")
		const piece = kept ? text : kind === "body" ? ` ${codeOf(bodyText(text), dialect)} ` : " "
		const edge = kind === "identifier" ? out.at(-1) : quoted ? piece[0] : undefined
		out += (edge !== undefined && WORD_CHAR.test(edge) ? " " : "") + piece
		quoted = kind === "identifier"
	}
	return out.replace(/\s+/g, " ").trim()
}

/**
 * A statement's code: identifiers kept, a DO body read as code itself, strings and comments one
 * space, whitespace collapsed; a SQLite pragma keeps a quoted value, its operand (S2 of r20)
 */
function codeOf(stmt: string, dialect: Dialect): string {
	const code = joined(stmt, dialect, false)
	return dialect === "sqlite" && /^PRAGMA\b/i.test(code) ? joined(stmt, dialect, true) : code
}

export { bodyText, codeOf, joined, segments, type Segment, WORD_CHAR }
