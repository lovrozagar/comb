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

const VALUE_ERRORS: Record<string, ValueProblem> = {
	/* a string past varchar(n), a number out of range, text that is no number, a NUL byte, a
	 * character the encoding has not got, a date that does not parse or is out of range */
	"22001": "invalid",
	"22003": "invalid",
	"22007": "invalid",
	"22008": "invalid",
	"22021": "invalid",
	"22P02": "invalid",
	"22P05": "invalid",
	/* a value too large for a btree index row */
	"54000": "too_large",
	/* a STRICT table's column given another type */
	SQLITE_CONSTRAINT_DATATYPE: "invalid",
	SQLITE_MISMATCH: "invalid",
	/* a string or blob past the engine's limit (D1's is 2 MB) */
	SQLITE_TOOBIG: "too_large",
}

/** Where the engine says the value was, when it says */
type ValueAt = { column?: string | undefined; table?: string | undefined }

/** The 400 for a value `code` says the column cannot hold, or undefined when `code` is not one */
function valueError(code: string, { column, table }: ValueAt, source: unknown): CombError | undefined {
	const problem = own(VALUE_ERRORS, code)
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
