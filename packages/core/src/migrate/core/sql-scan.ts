/**
 * SQL split into statements, normalized and hashed, read through the quote-aware lexer
 * (sql-lexer.ts), so `;`, `--` and `/*` inside a string or identifier are always data.
 */
import type { Dialect } from "../types.ts"
import { segments, WORD_CHAR } from "../../sql-lexer.ts"
import { pgStatements } from "./pg-split.ts"

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

// pg-split.ts, M75
/**
 * The statements of `sql`, without their terminating `;`. On SQLite they end where SQLite ends
 * them: at a `;` in code, never inside a literal or a comment, nor inside a trigger's body. On
 * Postgres they are the statements Postgres's own parser splits it into, so `await
 * loadPostgresParser()` first: until then it throws. A stretch that holds only comments is not a statement.
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

export { hashedSql, normalizeSql, splitSqlStatements }
