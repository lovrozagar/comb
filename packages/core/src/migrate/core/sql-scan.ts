/**
 * A quote-aware reading of SQL text: code, strings, identifiers and comments. Every migration
 * step that splits, hashes, terminates or classifies SQL reads it through here, so `;`, `--` and
 * `/*` inside a string or identifier are always data. The dialect decides the lexer: SQLite quotes
 * identifiers with `"`, backticks or brackets and has flat comments; Postgres quotes them with `"`
 * only, nests comments, escapes with backslashes in `E'…'`, and dollar-quotes `$tag$…$tag$`.
 */
import type { Dialect } from "../types.ts"
import { pgStatements } from "./pg-split.ts"

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

/*
 * Where SQLite ends a statement: the token state machine of its sqlite3_complete() (complete.c,
 * public domain). A ; ends one unless it is inside a trigger's body, which ends only at END then ;.
 * Only CREATE [TEMP] TRIGGER, after an optional EXPLAIN, opens a body, so begin, end and case are
 * whatever SQLite reads them as: a column, a table, a CASE (SL2 of r22).
 */
const SEMI = 0
const WS = 1
const OTHER = 2
/** The words the machine reads; every other word is OTHER */
// lookup-table: complete.c's keywords, each to its token
const KEYWORDS: ReadonlyMap<string, number> = /* @__PURE__ */ new Map([
	["create", 4],
	["end", 7],
	["explain", 3],
	["temp", 5],
	["temporary", 5],
	["trigger", 6],
])
/** The next state by state and token (SEMI, WS, OTHER, EXPLAIN, CREATE, TEMP, TRIGGER, END); state 1 is a statement ended */
const TRANSITIONS: ReadonlyArray<readonly number[]> = [
	/* 0 start */ [1, 0, 2, 3, 4, 2, 2, 2],
	/* 1 a statement ended */ [1, 1, 2, 3, 4, 2, 2, 2],
	/* 2 in a statement */ [1, 2, 2, 2, 2, 2, 2, 2],
	/* 3 after EXPLAIN */ [1, 3, 3, 2, 4, 2, 2, 2],
	/* 4 after CREATE */ [1, 4, 2, 2, 2, 4, 5, 2],
	/* 5 in a trigger */ [6, 5, 5, 5, 5, 5, 5, 5],
	/* 6 after a ; in a trigger */ [6, 6, 5, 5, 5, 5, 5, 7],
	/* 7 after END in a trigger */ [1, 7, 5, 5, 5, 5, 5, 5],
]
const ENDED = 1
/* complete.c's tokens in code: a ;, a run of its whitespace, a word of its identifier characters, any other character */
const TOKEN = /;|[ \t\n\f\r]+|[\w$\u0080-\uffff]+|[^;\w$\u0080-\uffff \t\n\f\r]/g

/** The statement being read: its text, its code alone, and the machine's state */
type Reading = { code: string; state: number; text: string }

/** The token a code token is to the machine */
function tokenOf(code: string): number {
	if (code === ";") return SEMI
	if (/^[ \t\n\f\r]/.test(code)) return WS
	return KEYWORDS.get(code.toLowerCase()) ?? OTHER
}

/** Moves the machine by `token`; true when it ends a statement */
function step(reading: Reading, token: number): boolean {
	reading.state = (TRANSITIONS[reading.state] as readonly number[])[token] as number
	return reading.state === ENDED
}

/** Append one code segment, ending a statement at each ; SQLite ends one at; returns finished statements */
function readCode(reading: Reading, text: string): string[] {
	const done: string[] = []
	for (const [code] of text.matchAll(TOKEN)) {
		reading.code += code
		if (step(reading, tokenOf(code))) done.push(finish(reading))
		else reading.text += code
	}
	return done
}

/** The statement read so far, reset for the next; empty when it held no code */
function finish(reading: Reading): string {
	const statement = reading.code.replace(/;/g, "").trim() === "" ? "" : reading.text.trim()
	reading.code = ""
	reading.state = 0
	reading.text = ""
	return statement
}

/**
 * The statements of `sql`, without their terminating `;`. On SQLite they end where SQLite ends
 * them: at a `;` in code, never inside a literal or a comment, nor inside a trigger's body. On Postgres
 * they are the statements Postgres runs, the one Postgres split (pg-split.ts, M75), read after
 * loadPostgresParser(). A stretch that holds only comments is not a statement.
 */
function splitSqlStatements(sql: string, dialect: Dialect = "sqlite"): string[] {
	if (dialect === "postgres") return pgStatements(sql)
	const reading: Reading = { code: "", state: 0, text: "" }
	const statements: string[] = []
	for (const segment of segments(sql, dialect)) {
		if (segment.kind === "code") statements.push(...readCode(reading, segment.text))
		else {
			/* complete.c reads a comment as whitespace, a string or a quoted name as one token */
			step(reading, segment.kind === "comment" ? WS : OTHER)
			reading.text += segment.text
		}
	}
	statements.push(finish(reading))
	return statements.filter((statement) => statement !== "")
}

/* the whitespace SQLite's tokenizer skips (sqlite3Isspace): any other space, U+00A0 or U+3000, is part of a name (SL5 of r22) */
const SQLITE_SPACE = /[\t\n\f\r ]+/g

/* a character SQLite reads into a bare word: a letter, digit, _, $, or any above ASCII */
const WORD_CHAR: RegExp = /[\w$\u0080-\uffff]/

/**
 * `sql` with comments dropped and SQLite's whitespace collapsed outside strings and identifiers, those
 * verbatim: two migrations that differ only in layout or comments normalize alike, two that differ
 * in data or names never. A migration's hash is taken over this form, so it stays as recorded: a
 * word written against a quoted name stays against it. `foldAll` is the form comb 0.5.0 to 0.20
 * hashed, which folded every Unicode space too, so `a b` and `a\u00a0b` (a column of type b, and a
 * column named a b) normalized alike (SL5 of r22).
 */
function hashedSql(sql: string, foldAll = false): string {
	return collapsed(sql, foldAll, false)
}

/**
 * `sql` as hashedSql collapses it, read as SQLite tokenizes it: a quoted name is a token of its own,
 * so a word written against one is set off by a space, as `ALTER TABLE "users"DROP COLUMN email`
 * drops the column `ALTER TABLE "users" DROP COLUMN email` does; `"main".t` and `"a"(` stay as written
 */
function normalizeSql(sql: string): string {
	return collapsed(sql, false, true)
}

/** `sql` with comments one space and whitespace collapsed outside strings and identifiers (see hashedSql), a quoted name set off from a word when `apart` */
function collapsed(sql: string, foldAll: boolean, apart: boolean): string {
	const space = foldAll ? /\s+/g : SQLITE_SPACE
	let out = ""
	let quoted = false
	for (const segment of segments(sql)) {
		const text =
			segment.kind === "comment" ? " " : segment.kind === "code" ? segment.text.replace(space, " ") : segment.text
		const edge = segment.kind === "identifier" ? out.at(-1) : quoted ? text[0] : undefined
		const sep = apart && edge !== undefined && WORD_CHAR.test(edge) ? " " : ""
		out += out.endsWith(" ") && text.startsWith(" ") ? text.slice(1) : sep + text
		quoted = segment.kind === "identifier"
	}
	return foldAll ? out.trim() : out.replace(/^ | $/g, "")
}

export { hashedSql, normalizeSql, segments, splitSqlStatements, type Segment, WORD_CHAR }
