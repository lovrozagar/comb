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
 * several lines, such as 0.4.x's flattened cause chain, is read from its last line up: the
 * engine's words come after the wrapper's SQL and params.
 */
export function readSqliteMessage(text: string): SqliteErrorRead | null {
	for (const line of text.split("\n").toReversed()) {
		const read = readLine(line.trim())
		if (read !== null) return read
	}
	return null
}

/** The SQLite engine error inside `error` (or the engine message `error` is), or null when there is none. */
export function readSqliteError(error: unknown): SqliteErrorRead | null {
	if (typeof error === "string") return readSqliteMessage(error)
	let query: string | undefined
	let current: unknown = error
	for (let depth = 0; depth < MAX_DEPTH && current instanceof Error; depth++) {
		const recorded = field(current, "query")
		if (query === undefined && typeof recorded === "string") query = recorded
		const read = readOne(current)
		if (read !== null) return { ...read, query }
		current = current.cause
	}
	return null
}
