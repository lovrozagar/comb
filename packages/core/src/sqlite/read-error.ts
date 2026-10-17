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

/** The code and message one error in the chain carries, or null. */
function readOne(error: Error): { code: string; message: string } | null {
	const extended = field(error, "extendedCode")
	if (sqliteCode(extended)) return { code: extended, message: error.message.replace(LIBSQL_PREFIX, "") }
	const code = field(error, "code")
	if (sqliteCode(code)) return { code, message: error.message }
	const d1 = D1_MESSAGE.exec(error.message)
	if (d1 === null) return null
	return { code: d1[3] ?? (d1[2] as string), message: d1[1] as string }
}

/* a bare engine message, as callers before 0.5.0 passed it, names its kind in its first words */
const STEMS: Array<[RegExp, string]> = [
	[/^UNIQUE constraint failed/i, "SQLITE_CONSTRAINT_UNIQUE"],
	[/^CHECK constraint failed/i, "SQLITE_CONSTRAINT_CHECK"],
	[/^NOT NULL constraint failed/i, "SQLITE_CONSTRAINT_NOTNULL"],
	[/^FOREIGN KEY constraint failed/i, "SQLITE_CONSTRAINT_FOREIGNKEY"],
]

/** An engine message given as text (D1, libsql or bare SQLite wording), or null. */
export function readSqliteMessage(text: string): SqliteErrorRead | null {
	const d1 = readOne(new Error(text))
	if (d1 !== null) return { ...d1, query: undefined }
	const message = text.replace(LIBSQL_PREFIX, "")
	const stem = STEMS.find(([pattern]) => pattern.test(message))
	return stem === undefined ? null : { code: stem[1], message, query: undefined }
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
