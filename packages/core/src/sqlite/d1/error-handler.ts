import { CombError } from "../../error.ts"
import { type ConstraintMap, combErrorKeys, type StatusKey } from "../../types.ts"
import { constraintError, resourceOutcome } from "../constraint-handler.ts"
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

/* D1 caps a LIKE or GLOB pattern at 50 bytes (SQLITE_LIMIT_LIKE_PATTERN_LENGTH): the request's to shorten (U21) */
const PATTERN_TOO_LONG: Outcome = {
	cause: "A like or ilike filter value with a * inside it may be at most 50 bytes on D1, once escaped.",
	errorKey: combErrorKeys.INVALID_VALUE,
	status: "bad_request",
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

/** Whether D1 refused a pattern over its LIKE cap: read from D1's message, never a wrapper's, which quotes bound values (Q4) */
const tooComplex = (error: Error): boolean =>
	platformMessage(error)?.includes("LIKE or GLOB pattern too complex") === true

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

/** The outcome for an engine error that is not a constraint violation: the shared resource table's, else a query error */
function engineOutcome(code: string): Outcome {
	return resourceOutcome(code) ?? QUERY_FAILED
}

/**
 * The CombError a Cloudflare D1 database error is: a constraint violation through the shared
 * SQLite handlers, then a query error (500) or a platform failure (transient 503, storage 422);
 * undefined for an error that is none of these. It throws nothing, so a caller can ask what an
 * error is (a unique violation it expects, say) without catching. The CombError's `cause` is safe
 * for clients; the original error, which holds the SQL and its bound values, is on `source`.
 */
function classifyD1Error(error: unknown, constraintMaps: ConstraintMap[]): CombError | undefined {
	if (!(error instanceof Error)) return undefined
	const constraint = constraintError(error, constraintMaps)
	if (constraint !== null) return constraint
	if (tooComplex(error)) return new CombError({ ...PATTERN_TOO_LONG, source: error })
	const read = readSqliteError(error)
	const platform = read === null ? platformMessage(error) : null
	if (read === null && platform === null) return undefined
	const outcome = read === null ? platformOutcome(platform as string) : engineOutcome(read.code)
	return new CombError({ ...outcome, source: error })
}

/** Throw the CombError classifyD1Error finds for `error`; return when it finds none */
function d1ErrorHandler(error: unknown, constraintMaps: ConstraintMap[]): void {
	const classified = classifyD1Error(error, constraintMaps)
	if (classified !== undefined) throw classified
}

export { classifyD1Error, d1ErrorHandler }
