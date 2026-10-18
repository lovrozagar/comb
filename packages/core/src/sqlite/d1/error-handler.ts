import { CombError } from "../../error.ts"
import { type ConstraintMap, combErrorKeys, type StatusKey } from "../../types.ts"
import { constraintError } from "../constraint-handler.ts"
import { readSqliteError } from "../read-error.ts"

/* Retryable per developers.cloudflare.com/d1/observability/debug-d1/, plus D1's overload and
 * limit resets. Only a platform message (one with no SQLite result code) is read for these, so
 * a query or bound value that happens to contain the words never matches. */
const D1_TRANSIENT_PATTERNS = [
	"network connection lost",
	"replica disconnected from primary",
	"transient issue on remote node",
	"client disconnected",
	"reset",
	"startup failure",
	"overloaded",
	"too many requests",
	"memory limit",
	"cpu time limit",
	"storage operation timeout",
	"starting up",
	/* Platform-side failure with a support reference; D1 already retried reads. */
	"internal error",
] as const

const D1_PREFIX = /\bD1_(?:ERROR|EXEC_ERROR|TYPE_ERROR|COLUMN_NOTFOUND)\b/

type Outcome = { cause: string; errorKey: string; status: StatusKey }

const QUERY_FAILED: Outcome = {
	cause: "The database rejected the query.",
	errorKey: combErrorKeys.DATABASE_IO_ERROR,
	status: "internal_server_error",
}

const STORAGE_FULL: Outcome = {
	cause: "The database storage limit has been reached.",
	errorKey: combErrorKeys.STORAGE_LIMIT_REACHED,
	status: "unprocessable_entity",
}

/**
 * The D1 platform message in the chain, read innermost first: the platform's error is the deepest,
 * and a wrapper's message (drizzle's carries the SQL and its params) never decides the outcome.
 */
function platformMessage(error: Error): string | null {
	const chain: Error[] = []
	for (let current: unknown = error; chain.length < 8 && current instanceof Error; current = current.cause) {
		chain.push(current)
	}
	const platform = chain
		.toReversed()
		.find((link) => typeof (link as { query?: unknown }).query !== "string" && D1_PREFIX.test(link.message))
	return platform?.message ?? null
}

function platformOutcome(message: string): Outcome {
	/* D1_TYPE_ERROR, D1_EXEC_ERROR and D1_COLUMN_NOTFOUND quote the query or a bound value: always a query error */
	if (!/\bD1_ERROR\b/.test(message)) return QUERY_FAILED
	const lower = message.toLowerCase()
	if (D1_TRANSIENT_PATTERNS.some((pattern) => lower.includes(pattern))) {
		return {
			cause: "The database is temporarily unavailable. Please retry.",
			errorKey: combErrorKeys.DATABASE_UNAVAILABLE,
			status: "service_unavailable",
		}
	}
	if (lower.includes("size limit") || lower.includes("storage limit")) return STORAGE_FULL
	return QUERY_FAILED
}

/** The outcome for an engine error that is not a constraint violation. */
function engineOutcome(code: string): Outcome {
	return code === "SQLITE_FULL" ? STORAGE_FULL : QUERY_FAILED
}

/**
 * Handle Cloudflare D1 database errors: constraint violations through the shared SQLite
 * handlers, then query errors (500) and platform failures (transient 503, storage 422).
 * The CombError's `cause` is safe for clients; the original error, which holds the SQL and
 * its bound values, is on `source`.
 */
function d1ErrorHandler(error: unknown, constraintMaps: ConstraintMap[]): void {
	if (!(error instanceof Error)) return
	const constraint = constraintError(error, constraintMaps)
	if (constraint !== null) throw constraint
	const read = readSqliteError(error)
	const platform = read === null ? platformMessage(error) : null
	if (read === null && platform === null) return
	const outcome = read === null ? platformOutcome(platform as string) : engineOutcome(read.code)
	throw new CombError({ ...outcome, source: error })
}

export { d1ErrorHandler }
