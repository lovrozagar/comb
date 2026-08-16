import { CombError } from "../../error.ts"
import { type ConstraintMap, combErrorKeys } from "../../types.ts"
import { handleConstraintViolation } from "../constraint-handler.ts"

const D1_TRANSIENT_PATTERNS = [
	"network connection lost",
	"reset",
	"startup failure",
	"overloaded",
	"too many requests",
	"memory limit",
	"cpu time limit",
	"storage operation timeout",
	"starting up",
] as const

function isTransientD1Error(message: string): boolean {
	const lower = message.toLowerCase()
	return D1_TRANSIENT_PATTERNS.some((p) => lower.includes(p))
}

/* Drizzle wraps D1 errors as `Failed query: ...` with the original D1 message on `cause`.
 * Walk the chain so handler sees `D1_ERROR: ...` regardless of wrapper depth. */
function flattenErrorMessages(error: Error): string {
	const parts: string[] = []
	let cur: unknown = error
	while (cur instanceof Error) {
		parts.push(cur.message)
		cur = cur.cause
	}
	return parts.join("\n")
}

/**
 * Handle Cloudflare D1 database errors.
 * D1 throws plain Error objects with message prefixes.
 * Categorizes storage, transient, execution, and constraint errors.
 */
function d1ErrorHandler(error: unknown, constraintMaps: ConstraintMap[]): void {
	if (!(error instanceof Error)) return
	const msg = flattenErrorMessages(error)

	/* Constraint violations come prefixed with D1_ERROR too — handle before infra check */
	handleConstraintViolation(msg, constraintMaps)

	/* Transient/storage infrastructure errors */
	if (msg.includes("D1_ERROR")) {
		if (isTransientD1Error(msg)) {
			throw new CombError({
				cause: `D1 transient error: ${msg}`,
				errorKey: combErrorKeys.DATABASE_UNAVAILABLE,
				status: "service_unavailable",
			})
		}
		if (msg.includes("size limit") || msg.includes("storage limit")) {
			throw new CombError({
				cause: msg,
				errorKey: combErrorKeys.STORAGE_LIMIT_REACHED,
				status: "unprocessable_entity",
			})
		}
		throw new CombError({
			cause: `D1 infrastructure error: ${msg}`,
			errorKey: combErrorKeys.DATABASE_IO_ERROR,
			status: "internal_server_error",
		})
	}

	/* Execution errors — bad SQL, type mismatches */
	if (msg.includes("D1_EXEC_ERROR") || msg.includes("D1_TYPE_ERROR") || msg.includes("D1_COLUMN_NOTFOUND")) {
		throw new CombError({
			cause: `D1 query error: ${msg}`,
			errorKey: combErrorKeys.DATABASE_IO_ERROR,
			status: "internal_server_error",
		})
	}
}

export { d1ErrorHandler }
