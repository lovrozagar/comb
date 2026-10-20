/**
 * What an SQLite engine said, whichever driver carried it. Classification reads the engine's
 * own (extended) result code, found by walking `.cause` past wrappers such as drizzle's
 * `DrizzleQueryError`, and never the wrapper's text, which holds the SQL and its parameters.
 */

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

/* libsql: `SQLITE_CONSTRAINT: <message>` */
const LIBSQL_PREFIX = /^SQLITE_[A-Z_]+: /

const MAX_DEPTH = 8

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
]

/** The extended code for `code`: a bare SQLITE_CONSTRAINT is refined from the wording, when it can be. */
function refine(code: string, message: string): { code: string; message: string } {
	if (code !== "SQLITE_CONSTRAINT") return { code, message }
	const stem = STEMS.find(([pattern]) => pattern.test(message))
	return { code: stem === undefined ? code : stem[1], message }
}

/** The code and message one error in the chain carries, or null. */
function readOne(error: Error): { code: string; message: string } | null {
	const extended = field(error, "extendedCode")
	if (sqliteCode(extended)) return refine(extended, error.message.replace(LIBSQL_PREFIX, ""))
	const code = field(error, "code")
	if (sqliteCode(code)) return refine(code, error.message)
	const d1 = D1_MESSAGE.exec(error.message)
	if (d1 === null) return null
	return refine(d1[3] ?? (d1[2] as string), d1[1] as string)
}

function readLine(line: string): SqliteErrorRead | null {
	const d1 = readOne(new Error(line))
	if (d1 !== null) return { ...d1, query: undefined }
	const message = line.replace(LIBSQL_PREFIX, "")
	const stem = STEMS.find(([pattern]) => pattern.test(message))
	return stem === undefined ? null : { code: stem[1], message, query: undefined }
}

/**
 * An engine message given as text (D1, libsql or bare SQLite wording), or null. Text with
 * several lines, such as 0.4.x's flattened cause chain, is read from its last non-empty line
 * alone: the engine's words come after the wrapper's SQL and params, and a line above them may be
 * a bound value a request shaped like an engine message.
 */
export function readSqliteMessage(text: string): SqliteErrorRead | null {
	const last = text
		.split("\n")
		.map((line) => line.trim())
		.findLast((line) => line !== "")
	return last === undefined ? null : readLine(last)
}

/** `error` and the errors under it on `.cause`, outermost first */
function chainOf(error: unknown): Error[] {
	const chain: Error[] = []
	for (let current = error; chain.length < MAX_DEPTH && current instanceof Error; current = current.cause) {
		chain.push(current)
	}
	return chain
}

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
	for (const link of chain.toReversed()) {
		/* a link that records its query is drizzle's wrapper: its message ends with the params */
		if (typeof field(link, "query") === "string") continue
		const read = readOne(link)
		if (read !== null) return { ...read, query }
	}
	return null
}
