import { CombError } from "../error.ts"
import { type ConstraintMap, combErrorKeys } from "../types.ts"

/**
 * Extract table and column from SQLite constraint error message.
 * Format: "UNIQUE constraint failed: store.slug"
 */
function extractTableColumn(message: string): {
	column: string | null
	table: string | null
} {
	const match = message.match(/constraint failed:\s*(\w+)\.(\w+)/i)
	if (match) return { column: match[2] ?? null, table: match[1] ?? null }
	/* SQLite FOREIGN KEY violations omit table.column — fall back to query text:
	 * `insert into "app_notification"`, `update "user"`, `delete from "org"`. */
	const tableMatch = message.match(/(?:insert into|update|delete from)\s+["`]?(\w+)["`]?/i)
	return { column: null, table: tableMatch?.[1] ?? null }
}

/**
 * Handle SQLite constraint violations by message content.
 * Shared between D1 and libsql error handlers — same SQLite messages.
 * Throws CombError if constraint matches.
 */
function handleConstraintViolation(rawMessage: string, constraintMaps: ConstraintMap[]): void {
	const message = rawMessage.toLowerCase()
	if (!message.includes("constraint")) return

	const { table, column } = extractTableColumn(message)

	/* Check mapped constraints first */
	for (const constraintMap of constraintMaps) {
		if (message.includes("unique") && table && column && constraintMap[table]?.unique?.[column]) {
			const { errorKey, cause, statusKey = "conflict" } = constraintMap[table].unique[column]
			throw new CombError({ cause, column, errorKey, status: statusKey, table })
		}

		if (message.includes("foreign key") && table && constraintMap[table]?.foreignKey) {
			const fkMap = constraintMap[table].foreignKey
			/* SQLite FK violations don't include the column. Use it when known, otherwise
			 * fall back to a single-column FK on the table (unambiguous). */
			const fkColumn = column ?? (Object.keys(fkMap).length === 1 ? Object.keys(fkMap)[0] : null)
			if (fkColumn && fkMap[fkColumn]) {
				const { errorKey, cause, statusKey = "conflict" } = fkMap[fkColumn]
				throw new CombError({ cause, column: fkColumn, errorKey, status: statusKey, table })
			}
		}

		if (message.includes("primary key") && table && constraintMap[table]?.primaryKey) {
			const { errorKey, cause, statusKey = "conflict" } = constraintMap[table].primaryKey
			throw new CombError({ cause, errorKey, status: statusKey, table })
		}

		if (message.includes("check constraint") && table && constraintMap[table]?.check) {
			const checkMappings = Object.values(constraintMap[table].check)
			const firstCheck = checkMappings[0]
			if (firstCheck) {
				const { errorKey, cause, statusKey = "bad_request" } = firstCheck
				throw new CombError({ cause, errorKey, status: statusKey, table })
			}
		}
	}

	/* Fallback for unmapped constraints */
	if (message.includes("unique")) {
		throw new CombError({
			cause: column ? `Duplicate value for ${table ? `${table}.` : ""}${column}` : "Duplicate value detected",
			column: column ?? undefined,
			errorKey: combErrorKeys.UNIQUE_CONSTRAINT_VIOLATION,
			status: "conflict",
			table: table ?? undefined,
		})
	}

	if (message.includes("foreign key")) {
		throw new CombError({
			cause: "Referenced record does not exist or is still in use",
			column: column ?? undefined,
			errorKey: combErrorKeys.FOREIGN_KEY_VIOLATION,
			status: "conflict",
			table: table ?? undefined,
		})
	}

	if (message.includes("primary key")) {
		throw new CombError({
			cause: "Duplicate primary key value",
			errorKey: combErrorKeys.PRIMARY_KEY_VIOLATION,
			status: "conflict",
			table: table ?? undefined,
		})
	}

	if (message.includes("not null")) {
		throw new CombError({
			cause: column ? `Required field missing: ${column}` : "Required field missing",
			column: column ?? undefined,
			errorKey: combErrorKeys.REQUIRED_FIELD_MISSING,
			status: "bad_request",
			table: table ?? undefined,
		})
	}

	if (message.includes("check constraint")) {
		throw new CombError({
			cause: "Data validation failed",
			errorKey: combErrorKeys.CHECK_CONSTRAINT_VIOLATION,
			status: "bad_request",
			table: table ?? undefined,
		})
	}
}

export { extractTableColumn, handleConstraintViolation }
