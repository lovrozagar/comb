/**
 * SQLite constraint violations mapped to CombErrors, one handler per extended result code.
 * Shared by the libsql, bun:sqlite and D1 handlers: the engine is the same, only the way the
 * driver carries the code differs, and `readSqliteError` absorbs that.
 */
import { type Fallback, type Found, findNamed, lookup, own, toCombError } from "../constraint-map.ts"
import { CombError } from "../error.ts"
import { type ConstraintMap, combErrorKeys } from "../types.ts"
import { valueError } from "../value-error.ts"
import { readSqliteError, type SqliteErrorRead } from "./read-error.ts"
import { statementHead, statementTable } from "../statement-head.ts"

type Violation = { maps: ConstraintMap[]; read: SqliteErrorRead; source: unknown }

/** The index a UNIQUE violation names instead of columns, when it is on an expression: `index 'u_email_lower'` */
const failedIndex = (message: string): string | undefined => /constraint failed: index '([^']+)'$/i.exec(message)?.[1]

/**
 * `UNIQUE constraint failed: member.first, member.last` → member, [first, last]. A table name may
 * hold any character but a dot here, as SQLite writes it unquoted: each pair splits on its last dot.
 */
function failedColumns(message: string): { columns: string[]; table: string | undefined } {
	const list = /constraint failed: (.+)$/i.exec(message)?.[1] ?? ""
	const pairs = list
		.split(", ")
		.map((pair) => /^(.+)\.([^.]+)$/.exec(pair.trim()))
		.filter((pair) => pair !== null)
	return { columns: pairs.map((pair) => pair[2] as string), table: pairs[0]?.[1] }
}

const toError = (v: Violation, found: Found) => toCombError(found, v.source)

/** A unique index on an expression, by name: in the statement's table first, as a CHECK, then in any */
function uniqueIndex(v: Violation, index: string): CombError {
	const fallback = {
		cause: "Duplicate value detected",
		errorKey: combErrorKeys.UNIQUE_CONSTRAINT_VIOLATION,
		status: "conflict",
	} as const
	const table = statementTable(v.read.query)
	const entry = lookup(v.maps, table, (t) => own(t.unique, index))
	if (entry !== undefined) return toError(v, { entry, fallback, table })
	const found = findNamed(v.maps, "unique", index)
	/* unmapped, the index is still the statement's table's, as Postgres names it (R11) */
	return toError(v, { entry: found?.entry, fallback, table: found?.table ?? table })
}

function unique(v: Violation): CombError {
	const index = failedIndex(v.read.message)
	if (index !== undefined) return uniqueIndex(v, index)
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
	/* the rest of the line: a name may hold any character, and an unnamed CHECK is its expression */
	const name = /CHECK constraint failed: (.+)$/i.exec(v.read.message)?.[1]
	const fallback = {
		cause: "Data validation failed",
		errorKey: combErrorKeys.CHECK_CONSTRAINT_VIOLATION,
		status: "bad_request",
	} as const
	/* CHECK names are only unique per table: look in the statement's table before any other */
	const table = statementTable(v.read.query)
	if (table !== undefined)
		return toError(v, { entry: lookup(v.maps, table, (t) => own(t.check, name)), fallback, table })
	const found = findNamed(v.maps, "check", name)
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

/**
 * A rule a trigger enforces with RAISE(ABORT | FAIL | ROLLBACK, message): a 400 whose cause is the
 * message the app wrote for it. A bare SQLITE_CONSTRAINT whose wording names no other kind is one
 * too, as D1 may report it without its extended code.
 */
const raised = (v: Violation): CombError =>
	new CombError({
		cause: v.read.message,
		errorKey: combErrorKeys.CONSTRAINT_VIOLATION,
		source: v.source,
		status: "bad_request",
	})

const CONSTRAINTS: Record<string, (v: Violation) => CombError> = {
	SQLITE_CONSTRAINT: raised,
	SQLITE_CONSTRAINT_CHECK: check,
	SQLITE_CONSTRAINT_FOREIGNKEY: foreignKey,
	SQLITE_CONSTRAINT_NOTNULL: notNull,
	SQLITE_CONSTRAINT_PRIMARYKEY: primaryKey,
	SQLITE_CONSTRAINT_TRIGGER: raised,
	SQLITE_CONSTRAINT_UNIQUE: unique,
}

/** A STRICT mismatch's `cannot store TEXT value in INTEGER column s.n` → s, n */
const mismatchAt = (message: string) => {
	const at = /\bcolumn (\w+)\.(\w+)$/.exec(message)
	return { column: at?.[2], table: at?.[1] }
}

/**
 * The CombError for an SQLite constraint violation inside `error`, or for a value its column
 * cannot hold (value-error.ts); null when it is neither.
 */
function constraintError(error: unknown, maps: ConstraintMap[]): CombError | null {
	const read = readSqliteError(error)
	if (read === null) return null
	const handler = own(CONSTRAINTS, read.code)
	if (handler !== undefined) return handler({ maps, read, source: error })
	return valueError(read.code, mismatchAt(read.message), error) ?? null
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

/** The outcome of an engine resource code, its extended form read as its primary; undefined for any other */
const resourceOutcome = (code: string | undefined): Fallback | undefined =>
	own(RESOURCE, code?.replace(/^(SQLITE_[A-Z]+)_.*$/, "$1"))

/**
 * The error handler for libsql, Turso and bun:sqlite: throws a CombError for constraint
 * violations and resource errors; any other error is left for the caller.
 */
function sqliteErrorHandler(error: unknown, maps: ConstraintMap[]): void {
	handleConstraintViolation(error, maps)
	const resource = resourceOutcome(readSqliteError(error)?.code)
	if (resource !== undefined) throw new CombError({ ...resource, source: error })
}

export { constraintError, handleConstraintViolation, resourceOutcome, sqliteErrorHandler }
