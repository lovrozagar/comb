import { CombError } from "../error.ts"
import { type ConstraintMap, combErrorKeys } from "../types.ts"

/**
 * PostgreSQL error codes
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const PG_ERROR_CODES = {
	/* Class 57 - Operator Intervention */
	ADMIN_SHUTDOWN: "57P01",
	/* Class 23 - Integrity Constraint Violation */
	CHECK_VIOLATION: "23514",
	/* Class 08 - Connection Exception */
	CONNECTION_FAILURE: "08006",
	/* Class 53 - Insufficient Resources */
	DISK_FULL: "53100",
	FOREIGN_KEY_VIOLATION: "23503",
	INSUFFICIENT_RESOURCES: "53000",
	INTEGRITY_CONSTRAINT_VIOLATION: "23000",
	NOT_NULL_VIOLATION: "23502",
	UNIQUE_VIOLATION: "23505",
}

/**
 * Check if error is a PostgreSQL DatabaseError
 */
function isPgDatabaseError(error: unknown): error is {
	code: string
	constraint?: string
	detail?: string
	message: string
	schema?: string
	table?: string
} {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof (error as { code: unknown }).code === "string"
	)
}

/**
 * Extract table and column from PostgreSQL error detail
 * Format: "Key (column)=(value) already exists"
 */
function extractColumnFromDetail(detail: string | undefined): string | null {
	if (!detail) return null
	const match = detail.match(/Key \((\w+)\)/i)
	return match?.[1] ?? null
}

/**
 * Handle PostgreSQL database errors.
 * Throws CombError if error matches storage or constraint violation.
 */
function pgErrorHandler(error: unknown, constraintMaps: ConstraintMap[]): void {
	if (!isPgDatabaseError(error)) return

	/* Storage errors */

	if (error.code === PG_ERROR_CODES.DISK_FULL) {
		throw new CombError({
			cause: "Your plan's database storage limit has been reached. Please upgrade your plan or delete unused data.",
			errorKey: combErrorKeys.STORAGE_LIMIT_REACHED,
			status: "unprocessable_entity",
		})
	}

	if (error.code === PG_ERROR_CODES.INSUFFICIENT_RESOURCES) {
		throw new CombError({
			cause: "Database resources exhausted. Please retry your request.",
			errorKey: combErrorKeys.DATABASE_IO_ERROR,
			status: "internal_server_error",
		})
	}

	if (error.code === PG_ERROR_CODES.CONNECTION_FAILURE) {
		throw new CombError({
			cause: "Database is temporarily unavailable. Please retry shortly.",
			errorKey: combErrorKeys.DATABASE_UNAVAILABLE,
			status: "service_unavailable",
		})
	}

	if (error.code === PG_ERROR_CODES.ADMIN_SHUTDOWN) {
		throw new CombError({
			cause: "Database is currently in maintenance mode. Please retry shortly.",
			errorKey: combErrorKeys.DATABASE_READONLY,
			status: "service_unavailable",
		})
	}

	/* Constraint violations */

	const table = error.table ?? null
	const column = extractColumnFromDetail(error.detail)
	const constraint = error.constraint ?? null

	/* Check mapped constraints first */
	for (const constraintMap of constraintMaps) {
		/* UNIQUE constraint (23505) */
		if (error.code === PG_ERROR_CODES.UNIQUE_VIOLATION) {
			if (table && column && constraintMap[table]?.unique?.[column]) {
				const { errorKey, cause, statusKey = "conflict" } = constraintMap[table].unique[column]
				throw new CombError({ cause, column, errorKey, status: statusKey, table })
			}
			/* Try constraint name as fallback */
			if (table && constraint && constraintMap[table]?.unique?.[constraint]) {
				const { errorKey, cause, statusKey = "conflict" } = constraintMap[table].unique[constraint]
				throw new CombError({ cause, column: constraint, errorKey, status: statusKey, table })
			}
		}

		/* FOREIGN KEY constraint (23503) */
		if (error.code === PG_ERROR_CODES.FOREIGN_KEY_VIOLATION) {
			if (table && column && constraintMap[table]?.foreignKey?.[column]) {
				const { errorKey, cause, statusKey = "conflict" } = constraintMap[table].foreignKey[column]
				throw new CombError({ cause, column, errorKey, status: statusKey, table })
			}
			if (table && constraint && constraintMap[table]?.foreignKey?.[constraint]) {
				const { errorKey, cause, statusKey = "conflict" } = constraintMap[table].foreignKey[constraint]
				throw new CombError({ cause, column: constraint, errorKey, status: statusKey, table })
			}
		}

		/* PRIMARY KEY constraint (23000) */
		if (error.code === PG_ERROR_CODES.INTEGRITY_CONSTRAINT_VIOLATION) {
			if (table && constraintMap[table]?.primaryKey) {
				const { errorKey, cause, statusKey = "conflict" } = constraintMap[table].primaryKey
				throw new CombError({ cause, errorKey, status: statusKey, table })
			}
		}

		/* CHECK constraint (23514) */
		if (error.code === PG_ERROR_CODES.CHECK_VIOLATION) {
			if (table && constraint && constraintMap[table]?.check?.[constraint]) {
				const { errorKey, cause, statusKey = "bad_request" } = constraintMap[table].check[constraint]
				throw new CombError({ cause, errorKey, status: statusKey, table })
			}
		}
	}

	/* Fallback for unmapped constraints */
	if (error.code === PG_ERROR_CODES.UNIQUE_VIOLATION) {
		throw new CombError({
			cause: column ? `Duplicate value for ${table ? `${table}.` : ""}${column}` : "Duplicate value detected",
			column: column ?? undefined,
			errorKey: combErrorKeys.UNIQUE_CONSTRAINT_VIOLATION,
			status: "conflict",
			table: table ?? undefined,
		})
	}

	if (error.code === PG_ERROR_CODES.FOREIGN_KEY_VIOLATION) {
		throw new CombError({
			cause: "Referenced record does not exist or is still in use",
			column: column ?? undefined,
			errorKey: combErrorKeys.FOREIGN_KEY_VIOLATION,
			status: "conflict",
			table: table ?? undefined,
		})
	}

	if (error.code === PG_ERROR_CODES.INTEGRITY_CONSTRAINT_VIOLATION) {
		throw new CombError({
			cause: "Duplicate primary key value",
			errorKey: combErrorKeys.PRIMARY_KEY_VIOLATION,
			status: "conflict",
			table: table ?? undefined,
		})
	}

	if (error.code === PG_ERROR_CODES.NOT_NULL_VIOLATION) {
		throw new CombError({
			cause: column ? `Required field missing: ${column}` : "Required field missing",
			column: column ?? undefined,
			errorKey: combErrorKeys.REQUIRED_FIELD_MISSING,
			status: "bad_request",
			table: table ?? undefined,
		})
	}

	if (error.code === PG_ERROR_CODES.CHECK_VIOLATION) {
		throw new CombError({
			cause: "Data validation failed",
			errorKey: combErrorKeys.CHECK_CONSTRAINT_VIOLATION,
			status: "bad_request",
			table: table ?? undefined,
		})
	}
}

export { pgErrorHandler }
