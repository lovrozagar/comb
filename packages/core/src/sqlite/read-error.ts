/**
 * What an SQLite engine said, whichever driver carried it. Classification reads the engine's
 * own (extended) result code, found by walking `.cause` past wrappers such as drizzle's
 * `DrizzleQueryError`, and never the wrapper's text, which holds the SQL and its parameters.
 */
import { own } from "../constraint-map.ts"
import { causeChain, innermostFirst } from "../error-chain.ts"

export type SqliteErrorRead = {
	/** The extended result code when the driver reports one, e.g. `SQLITE_CONSTRAINT_UNIQUE`. */
	code: string
	/** The engine's message without driver prefixes or code suffixes. */
	message: string
	/** The SQL a wrapper recorded as structured data (drizzle's `query`), if any. */
	query: string | undefined
}

/* D1: `D1_ERROR: <message>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)` */
const D1_MESSAGE = /^(?:D1_ERROR: )?([\s\S]*): (SQLITE_[A-Z_]+)(?: \(extended: (SQLITE_[A-Z_]+)\))?$/

/*
 * D1's exec(): `Error in line N: <the statement>: <message>`, the statement values and all, with
 * nothing that marks where it ends: no word of it is the engine's own (Q8 of r17)
 */
const D1_EXEC = /^(?:D1_EXEC_ERROR: )?Error in line \d+: /

/* libsql: `SQLITE_CONSTRAINT: <message>`, the prefix twice from batch() (Q8 of r18) */
const LIBSQL_PREFIX = /^(?:SQLITE_[A-Z_]+: )+/

/*
 * SQLite's extended constraint codes by number, which libsql names `UNKNOWN_SQLITE_ERROR_<n>` when
 * its own table lacks them (3091 and 2835, newer than it); https://sqlite.org/rescode.html
 */
const CONSTRAINT_CODES: Record<string, string> = {
	275: "SQLITE_CONSTRAINT_CHECK",
	531: "SQLITE_CONSTRAINT_COMMITHOOK",
	787: "SQLITE_CONSTRAINT_FOREIGNKEY",
	1043: "SQLITE_CONSTRAINT_FUNCTION",
	1299: "SQLITE_CONSTRAINT_NOTNULL",
	1555: "SQLITE_CONSTRAINT_PRIMARYKEY",
	1811: "SQLITE_CONSTRAINT_TRIGGER",
	2067: "SQLITE_CONSTRAINT_UNIQUE",
	2323: "SQLITE_CONSTRAINT_VTAB",
	2579: "SQLITE_CONSTRAINT_ROWID",
	2835: "SQLITE_CONSTRAINT_PINNED",
	3091: "SQLITE_CONSTRAINT_DATATYPE",
}

/** libsql's extended code as SQLite names it: `UNKNOWN_SQLITE_ERROR_3091` is SQLITE_CONSTRAINT_DATATYPE */
const named = (code: unknown): unknown =>
	typeof code === "string" && code.startsWith("UNKNOWN_SQLITE_ERROR_")
		? own(CONSTRAINT_CODES, code.slice("UNKNOWN_SQLITE_ERROR_".length))
		: code

function field(error: Error, name: string): unknown {
	return (error as unknown as Record<string, unknown>)[name]
}

const sqliteCode = (value: unknown): value is string => typeof value === "string" && value.startsWith("SQLITE_")

/* SQLite names a constraint's kind in the message's first words; a bare message (as callers
 * before 0.5.0 passed it) or a bare SQLITE_CONSTRAINT code is classified by them */
const STEMS: Array<[RegExp, string]> = [
	[/^UNIQUE constraint failed/i, "SQLITE_CONSTRAINT_UNIQUE"],
	[/^CHECK constraint failed/i, "SQLITE_CONSTRAINT_CHECK"],
	[/^NOT NULL constraint failed/i, "SQLITE_CONSTRAINT_NOTNULL"],
	[/^FOREIGN KEY constraint failed/i, "SQLITE_CONSTRAINT_FOREIGNKEY"],
	/* a STRICT column given another type, which libsql reports as UNKNOWN_SQLITE_ERROR_3091 */
	[/^cannot store \w+ value in \w+ column /i, "SQLITE_CONSTRAINT_DATATYPE"],
	/* SQLite's own words for a virtual table's key conflict, an FTS5 duplicate rowid, which D1 sends with no extended code (Q12 of r17) */
	[/^constraint failed$/i, "SQLITE_CONSTRAINT_PRIMARYKEY"],
]

/** The extended code for `code`: a bare SQLITE_CONSTRAINT is refined from the wording, when it can be. */
function refine(code: string, message: string): { code: string; message: string } {
	if (code !== "SQLITE_CONSTRAINT") return { code, message }
	const stem = STEMS.find(([pattern]) => pattern.test(message))
	return { code: stem === undefined ? code : stem[1], message }
}

/** The code and message one error in the chain carries, or null. */
function readOne(error: Error): { code: string; message: string } | null {
	const extended = named(field(error, "extendedCode"))
	if (sqliteCode(extended)) return refine(extended, error.message.replace(LIBSQL_PREFIX, ""))
	const code = field(error, "code")
	if (sqliteCode(code)) return refine(code, error.message.replace(LIBSQL_PREFIX, ""))
	const d1 = D1_MESSAGE.exec(error.message)
	if (d1 === null) return null
	if (!D1_EXEC.test(error.message)) return refine(d1[3] ?? (d1[2] as string), d1[1] as string)
	/* the code alone, past the statement exec() quotes: each handler then answers its generic cause. SQLite's
	   bare words for a virtual table's key conflict end the text with no code beyond the bare one, which an
	   app's RAISE never is, as it carries _TRIGGER: read as prepare reads them (Q9 of r18) */
	const vtabKey = d1[3] === undefined && d1[2] === "SQLITE_CONSTRAINT" && /: constraint failed$/i.test(d1[1] as string)
	return refine(vtabKey ? "SQLITE_CONSTRAINT_PRIMARYKEY" : (d1[3] ?? (d1[2] as string)), "")
}

function readLine(line: string): SqliteErrorRead | null {
	const d1 = readOne(new Error(line))
	if (d1 !== null) return { ...d1, query: undefined }
	const message = line.replace(LIBSQL_PREFIX, "")
	const stem = STEMS.find(([pattern]) => pattern.test(message))
	return stem === undefined ? null : { code: stem[1], message, query: undefined }
}

/**
 * An engine message given as text (D1, libsql or bare SQLite wording), or null. Text with several
 * lines is read from its last non-empty line, where an engine puts its words. Text with a `params:`
 * line (0.4.x's flattened cause chain, drizzle's wrapper message) is not read at all: a bound value
 * may hold a newline and write that last line itself, and nothing in the text tells its lines apart.
 */
export function readSqliteMessage(text: string): SqliteErrorRead | null {
	const lines = text.split("\n").map((line) => line.trim())
	if (lines.some((line) => /^params:/i.test(line))) return null
	const last = lines.filter((line) => line !== "").at(-1)
	return last === undefined ? null : readLine(last)
}

/** `error` and the errors under it on `.cause`, outermost first (error-chain.ts) */
const chainOf = (error: unknown): Error[] => causeChain(error).filter((link): link is Error => link instanceof Error)

/**
 * The SQLite engine error inside `error` (or the engine message `error` is), or null when there is none.
 * The chain is read innermost first: the engine's error is the deepest, and a wrapper's message
 * ends with the bound params, which a request controls and may shape like an engine message.
 */
export function readSqliteError(error: unknown): SqliteErrorRead | null {
	if (typeof error === "string") return readSqliteMessage(error)
	const chain = chainOf(error)
	const query = chain.map((link) => field(link, "query")).find((recorded) => typeof recorded === "string") as
		| string
		| undefined
	for (const link of innermostFirst(chain)) {
		/* a link that records its query is drizzle's wrapper: its message ends with the params */
		if (typeof field(link, "query") === "string") continue
		const read = readOne(link)
		if (read !== null) return { ...read, query }
	}
	return null
}
