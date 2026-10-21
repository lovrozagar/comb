/**
 * SQLite constraint violations mapped to CombErrors, one handler per extended result code.
 * Shared by the libsql, bun:sqlite and D1 handlers: the engine is the same, only the way the
 * driver carries the code differs, and `readSqliteError` absorbs that.
 */
import { type Fallback, type Found, findCheck, lookup, own, toCombError } from "../constraint-map.ts"
import { CombError } from "../error.ts"
import { type ConstraintMap, combErrorKeys } from "../types.ts"
import { readSqliteError, type SqliteErrorRead } from "./read-error.ts"
import { statementHead } from "./statement-head.ts"

type Violation = { maps: ConstraintMap[]; read: SqliteErrorRead; source: unknown }

/** `UNIQUE constraint failed: member.first, member.last` → member, [first, last] */
function failedColumns(message: string): { columns: string[]; table: string | undefined } {
	const list = /constraint failed: (.+)$/i.exec(message)?.[1] ?? ""
	const pairs = list
		.split(", ")
		.map((pair) => /^(\w+)\.(\w+)$/.exec(pair.trim()))
		.filter((pair) => pair !== null)
	return { columns: pairs.map((pair) => pair[2] as string), table: pairs[0]?.[1] }
}

/* the table an INSERT, UPDATE or DELETE targets, from the SQL a wrapper recorded, read from the
 * statement's own verb on */
const STATEMENT_TABLE =
	/^(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["`[]?(\w+)/i
const statementTable = (query: string | undefined) => STATEMENT_TABLE.exec(statementHead(query ?? ""))?.[1]

const toError = (v: Violation, found: Found) => toCombError(found, v.source)

function unique(v: Violation): CombError {
	const { columns, table } = failedColumns(v.read.message)
	/* a composite unique is keyed by its columns together; one column alone would blame half the pair */
	const column = columns.length === 1 ? columns[0] : undefined
	const entry = lookup(v.maps, table, (t) => own(t.unique, columns.join(",")))
	const cause =
		columns.length === 0
			? "Duplicate value detected"
			: `Duplicate value for ${columns.map((c) => `${table}.${c}`).join(", ")}`
	const fallback = { cause, errorKey: combErrorKeys.UNIQUE_CONSTRAINT_VIOLATION, status: "conflict" } as const
	return toError(v, { column, entry, fallback, table })
}

function primaryKey(v: Violation): CombError {
	const { columns, table } = failedColumns(v.read.message)
	/* a map written before 0.5.0 may list the key column under `unique` */
	const entry = lookup(v.maps, table, (t) => t.primaryKey ?? own(t.unique, columns[0]))
	const fallback = {
		cause: "Duplicate primary key value",
		errorKey: combErrorKeys.PRIMARY_KEY_VIOLATION,
		status: "conflict",
	} as const
	return toError(v, { entry, fallback, table })
}

function check(v: Violation): CombError {
	const name = /CHECK constraint failed: (\w+)$/i.exec(v.read.message)?.[1]
	const fallback = {
		cause: "Data validation failed",
		errorKey: combErrorKeys.CHECK_CONSTRAINT_VIOLATION,
		status: "bad_request",
	} as const
	/* CHECK names are only unique per table: look in the statement's table before any other */
	const table = statementTable(v.read.query)
	if (table !== undefined)
		return toError(v, { entry: lookup(v.maps, table, (t) => own(t.check, name)), fallback, table })
	const found = findCheck(v.maps, name)
	return toError(v, { entry: found?.entry, fallback, table: found?.table })
}

function notNull(v: Violation): CombError {
	const { columns, table } = failedColumns(v.read.message)
	const column = columns[0]
	return new CombError({
		cause: column === undefined ? "Required field missing" : `Required field missing: ${column}`,
		column,
		errorKey: combErrorKeys.REQUIRED_FIELD_MISSING,
		source: v.source,
		status: "bad_request",
		table,
	})
}

/* the generic causes of a foreign key violation, by which side of the key the statement touched */
const STILL_REFERENCED = "The record is still referenced by other records"
const MISSING_OR_REFERENCED = "Referenced record does not exist or is still in use"

/* SQLite's FOREIGN KEY message names neither table nor column; the statement's target table
 * does, and a table with one foreign key leaves no doubt about the column. A DELETE can only
 * fail on the other side, a row that references the deleted one, so no key of its own is blamed. */
function foreignKey(v: Violation): CombError {
	const table = statementTable(v.read.query)
	if (/^delete\b/i.test(statementHead(v.read.query ?? ""))) {
		const fallback = {
			cause: STILL_REFERENCED,
			errorKey: combErrorKeys.FOREIGN_KEY_VIOLATION,
			status: "conflict",
		} as const
		return toError(v, { entry: undefined, fallback, table })
	}
	let column: string | undefined
	const entry = lookup(v.maps, table, (t) => {
		const keys = Object.keys(t.foreignKey ?? {})
		column = keys.length === 1 ? keys[0] : undefined
		return own(t.foreignKey, column)
	})
	const fallback = {
		cause: MISSING_OR_REFERENCED,
		errorKey: combErrorKeys.FOREIGN_KEY_VIOLATION,
		status: "conflict",
	} as const
	return toError(v, { column: entry === undefined ? undefined : column, entry, fallback, table })
}

const CONSTRAINTS: Record<string, (v: Violation) => CombError> = {
	SQLITE_CONSTRAINT_CHECK: check,
	SQLITE_CONSTRAINT_FOREIGNKEY: foreignKey,
	SQLITE_CONSTRAINT_NOTNULL: notNull,
	SQLITE_CONSTRAINT_PRIMARYKEY: primaryKey,
	SQLITE_CONSTRAINT_UNIQUE: unique,
}

/** The CombError for an SQLite constraint violation inside `error`, or null when it is not one. */
function constraintError(error: unknown, maps: ConstraintMap[]): CombError | null {
	const read = readSqliteError(error)
	const handler = read === null ? undefined : own(CONSTRAINTS, read.code)
	return read === null || handler === undefined ? null : handler({ maps, read, source: error })
}

/**
 * Throws the mapped CombError when `error` is an SQLite constraint violation; otherwise returns.
 * `error` is the thrown error, wrapper and all, or an engine message given as text.
 */
function handleConstraintViolation(error: unknown, maps: ConstraintMap[]): void {
	const mapped = constraintError(error, maps)
	if (mapped !== null) throw mapped
}

/* the engine's resource codes, which a retry or a bigger plan can fix */
const RESOURCE: Record<string, Fallback> = {
	SQLITE_BUSY: {
		cause: "Database is busy. Please retry shortly.",
		errorKey: combErrorKeys.DATABASE_UNAVAILABLE,
		status: "service_unavailable",
	},
	SQLITE_FULL: {
		cause: "The database storage limit has been reached.",
		errorKey: combErrorKeys.STORAGE_LIMIT_REACHED,
		status: "unprocessable_entity",
	},
	SQLITE_LOCKED: {
		cause: "Database is busy. Please retry shortly.",
		errorKey: combErrorKeys.DATABASE_UNAVAILABLE,
		status: "service_unavailable",
	},
	SQLITE_READONLY: {
		cause: "Database is read-only right now.",
		errorKey: combErrorKeys.DATABASE_READONLY,
		status: "service_unavailable",
	},
}

/**
 * The error handler for libsql, Turso and bun:sqlite: throws a CombError for constraint
 * violations and resource errors; any other error is left for the caller.
 */
function sqliteErrorHandler(error: unknown, maps: ConstraintMap[]): void {
	handleConstraintViolation(error, maps)
	const read = readSqliteError(error)
	const resource = own(RESOURCE, read?.code.replace(/^(SQLITE_[A-Z]+)_.*$/, "$1"))
	if (resource !== undefined) throw new CombError({ ...resource, source: error })
}

export { constraintError, handleConstraintViolation, sqliteErrorHandler }
