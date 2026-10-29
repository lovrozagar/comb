/**
 * A value the request sent that the column cannot hold, by the engine's code, on every dialect:
 * one table for Postgres' SQLSTATEs and SQLite's result codes, so the same bad value is the same
 * 400 on libsql, bun:sqlite, D1 and Postgres. The message names the column, never the value. The
 * rest of Postgres class 22 (a division by zero, say) comes from the server's own SQL and stays
 * the caller's.
 */
import { own } from "./constraint-map.ts"
import { CombError } from "./error.ts"
import { combErrorKeys } from "./types.ts"

type ValueProblem = "invalid" | "too_large"
/** A code that is a value's problem only when the engine's message says so */
type ValueRule = ValueProblem | { message: RegExp; problem: ValueProblem }

const VALUE_ERRORS: Record<string, ValueRule> = {
	/* a string past varchar(n), a number out of range, text that is no number, a NUL byte, a
	 * character the encoding has not got, a date that does not parse or is out of range */
	"22001": "invalid",
	"22003": "invalid",
	"22007": "invalid",
	"22008": "invalid",
	"22021": "invalid",
	"22P02": "invalid",
	"22P05": "invalid",
	/* a time zone offset past what Postgres holds, 15:59 either way (F4 of the 0.14.1 review) */
	"22009": "invalid",
	/* a value too large for a btree index row */
	"54000": "too_large",
	/* a STRICT table's column given another type */
	SQLITE_CONSTRAINT_DATATYPE: "invalid",
	SQLITE_MISMATCH: "invalid",
	/* a string or blob past the engine's limit (D1's is 2 MB); SQLITE_TOOBIG is also a statement past
	 * its length limit, which the server built, since comb binds every value (C6) */
	SQLITE_TOOBIG: { message: /\bstring or blob too big\b/i, problem: "too_large" },
}

/** The engine's error: its code, and the message a code's rule may read */
type ValueRead = { code: string; message?: string | undefined }

/** Where the engine says the value was, when it says */
type ValueAt = { column?: string | undefined; table?: string | undefined }

/** The problem `read` is of a value the column cannot hold, or undefined when it is none */
function problemOf({ code, message }: ValueRead): ValueProblem | undefined {
	const rule = own(VALUE_ERRORS, code)
	if (rule === undefined || typeof rule === "string") return rule
	return rule.message.test(message ?? "") ? rule.problem : undefined
}

/** The 400 for a value `read` says the column cannot hold, or undefined when it is not one */
function valueError(read: ValueRead, { column, table }: ValueAt, source: unknown): CombError | undefined {
	const problem = problemOf(read)
	if (problem === undefined) return undefined
	const [what, errorKey] =
		problem === "invalid"
			? ["Invalid value", combErrorKeys.INVALID_VALUE]
			: ["Value too large", combErrorKeys.VALUE_TOO_LARGE]
	return new CombError({
		cause: column === undefined ? what : `${what} for ${column}`,
		column,
		errorKey,
		source,
		status: "bad_request",
		table,
	})
}

export { valueError }
