/**
 * SQLite constraint violations mapped to CombErrors, one handler per extended result code.
 * Shared by the libsql, bun:sqlite and D1 handlers: the engine is the same, only the way the
 * driver carries the code differs, and `readSqliteError` absorbs that.
 */
import { CombError } from "../error.ts"
import { type ConstraintMap, type ConstraintMapEntry, combErrorKeys, type StatusKey } from "../types.ts"
import { readSqliteError, type SqliteErrorRead } from "./read-error.ts"

type Table = NonNullable<ConstraintMap[string]>
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

/** The first map entry `pick` finds for `table`. */
function lookup(maps: ConstraintMap[], table: string | undefined, pick: (t: Table) => ConstraintMapEntry | undefined) {
	if (table === undefined) return undefined
	for (const map of maps) {
		const entry = Object.hasOwn(map, table) ? pick(map[table] as Table) : undefined
		if (entry !== undefined) return entry
	}
	return undefined
}

const own = <T>(record: Record<string, T> | undefined, key: string | undefined): T | undefined =>
	record !== undefined && key !== undefined && Object.hasOwn(record, key) ? record[key] : undefined

type Fallback = { cause: string; errorKey: string; status: StatusKey }

/** What a handler found: the map entry, if any, the generic error otherwise, and where. */
type Found = {
	column?: string | undefined
	entry: ConstraintMapEntry | undefined
	fallback: Fallback
	table?: string | undefined
}

function toError(v: Violation, { column, entry, fallback, table }: Found): CombError {
	if (entry === undefined) return new CombError({ ...fallback, column, source: v.source, table })
	const status = entry.statusKey ?? (fallback.status === "bad_request" ? "bad_request" : "conflict")
	return new CombError({ cause: entry.cause, column, errorKey: entry.errorKey, source: v.source, status, table })
}

function unique(v: Violation): CombError {
	const { columns, table } = failedColumns(v.read.message)
	const column = columns[0]
	const entry = lookup(v.maps, table, (t) => own(t.unique, column))
	const cause = column === undefined ? "Duplicate value detected" : `Duplicate value for ${table}.${column}`
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
	for (const map of v.maps) {
		for (const [table, t] of Object.entries(map)) {
			const entry = own(t.check, name)
			if (entry !== undefined) return toError(v, { entry, fallback, table })
		}
	}
	return toError(v, { entry: undefined, fallback })
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

/* SQLite's FOREIGN KEY message names neither table nor column; the statement's target table
 * does, and a table with one foreign key leaves no doubt about the column */
function foreignKey(v: Violation): CombError {
	const table = /^\s*(?:insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from)\s+["`[]?(\w+)/i.exec(
		v.read.query ?? "",
	)?.[1]
	let column: string | undefined
	const entry = lookup(v.maps, table, (t) => {
		const keys = Object.keys(t.foreignKey ?? {})
		column = keys.length === 1 ? keys[0] : undefined
		return own(t.foreignKey, column)
	})
	const fallback = {
		cause: "Referenced record does not exist or is still in use",
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

/** Throws the mapped CombError when `error` is an SQLite constraint violation; otherwise returns. */
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
