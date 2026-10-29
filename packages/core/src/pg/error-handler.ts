/**
 * PostgreSQL errors mapped to CombErrors, one handler per SQLSTATE. The server's error is found
 * by walking `.cause` past wrappers such as drizzle's; node-postgres, postgres.js and Bun.SQL
 * name its fields differently, and `readPgError` reads all three.
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
import {
	type Fallback,
	type Found,
	findNamed,
	lookup,
	own,
	shown,
	shownColumn,
	type TableMap,
	toCombError,
} from "../constraint-map.ts"
import { CombError } from "../error.ts"
import { type ConstraintMap, combErrorKeys } from "../types.ts"
import { truncateUtf8 } from "../identifier.ts"
import { mapTable } from "./map-table.ts"
import { type PgErrorRead, readPgError } from "./read-error.ts"
import { statementTable } from "../statement-head.ts"
import { valueError } from "../value-error.ts"

/** A violation, `table` the violated table's key in the maps: qualified for a pgSchema's (F51) */
type Violation = { maps: ConstraintMap[]; read: PgErrorRead; source: unknown; table: string | undefined }

const toError = (v: Violation, found: Found) => toCombError(found, v.source)

/* Postgres names a primary key `<table>_pkey`, the table cut so the whole fits its 63-byte identifiers */
const pkeyOf = (table: string) => `${truncateUtf8(table, 58)}_pkey`

function unique(v: Violation): CombError {
	const { constraint, keyColumns: columns } = v.read
	const { table } = v
	/* Postgres names the key for the table alone, its schema apart */
	if (constraint !== undefined && v.read.table !== undefined && constraint === pkeyOf(v.read.table))
		return primaryKey(v)
	/* a composite unique is keyed by its columns together; one column alone would blame half the pair. An
	   expression may spell any column, a private one too, so a key holding one names none (Q3), and is
	   found in the map by the index's name alone */
	const { keyExpression } = v.read
	const visible = keyExpression ? [] : shown(v.maps, table, columns)
	const column = visible.length === 1 ? visible[0] : undefined
	const byColumns = (t: TableMap) => (keyExpression ? undefined : own(t.unique, columns.join(",")))
	const entry = lookup(v.maps, table, (t) => byColumns(t) ?? own(t.unique, constraint))
	const named = visible.map((c) => (table === undefined ? c : `${table}.${c}`)).join(", ")
	const cause = named === "" ? "Duplicate value detected" : `Duplicate value for ${named}`
	const fallback = { cause, errorKey: combErrorKeys.UNIQUE_CONSTRAINT_VIOLATION, status: "conflict" } as const
	return toError(v, { column, entry, fallback, table })
}

function primaryKey(v: Violation): CombError {
	const { keyColumns: columns } = v.read
	const { table } = v
	/* a map written before 0.5.0 may list the key column under `unique` */
	const entry = lookup(v.maps, table, (t) => t.primaryKey ?? own(t.unique, columns[0]))
	const fallback = {
		cause: "Duplicate primary key value",
		errorKey: combErrorKeys.PRIMARY_KEY_VIOLATION,
		status: "conflict",
	} as const
	return toError(v, { entry, fallback, table })
}

function foreignKey(v: Violation): CombError {
	const { constraint, keyColumns: columns, referenced } = v.read
	const { table } = v
	/* the key named is the parent's, on a child's constraint: nothing in the map describes it. The
	   table is the statement's, the parent's, as SQLite can name it too (R11); unknown without the SQL */
	if (referenced) {
		const fallback = {
			cause: "The record is still referenced by other records",
			errorKey: combErrorKeys.FOREIGN_KEY_VIOLATION,
			status: "conflict",
		} as const
		return toError(v, { entry: undefined, fallback, table: statementTable(v.read.query) })
	}
	const column = columns[0]
	const entry = lookup(v.maps, table, (t) => own(t.foreignKey, column) ?? own(t.foreignKey, constraint))
	const fallback = {
		cause: "Referenced record does not exist or is still in use",
		errorKey: combErrorKeys.FOREIGN_KEY_VIOLATION,
		status: "conflict",
	} as const
	return toError(v, { column: shownColumn(v.maps, table, column), entry, fallback, table })
}

function check(v: Violation): CombError {
	const { constraint } = v.read
	const { table } = v
	const fallback = {
		cause: "Data validation failed",
		errorKey: combErrorKeys.CHECK_CONSTRAINT_VIOLATION,
		status: "bad_request",
	} as const
	if (table !== undefined)
		return toError(v, { entry: lookup(v.maps, table, (t) => own(t.check, constraint)), fallback, table })
	const found = findNamed(v.maps, "check", constraint)
	return toError(v, { entry: found?.entry, fallback, table: found?.table })
}

function notNull(v: Violation): CombError {
	const { table } = v
	const column = shownColumn(v.maps, table, v.read.column)
	return new CombError({
		cause: column === undefined ? "Required field missing" : `Required field missing: ${column}`,
		column,
		errorKey: combErrorKeys.REQUIRED_FIELD_MISSING,
		source: v.source,
		status: "bad_request",
		table,
	})
}

/** An EXCLUDE constraint's violation, an overlapping row: the map's entry by name, else a 409 */
function exclusion(v: Violation): CombError {
	const { constraint } = v.read
	const { table } = v
	const fallback = {
		cause: "The record conflicts with an existing one",
		errorKey: combErrorKeys.EXCLUSION_CONSTRAINT_VIOLATION,
		status: "conflict",
	} as const
	return toError(v, { entry: lookup(v.maps, table, (t) => own(t.exclusion, constraint)), fallback, table })
}

/** A rule a trigger or function enforces with RAISE EXCEPTION (P0001): a 400 whose cause is its message */
function raised(v: Violation): CombError {
	return new CombError({
		cause: v.read.message ?? "Constraint violated",
		errorKey: combErrorKeys.CONSTRAINT_VIOLATION,
		source: v.source,
		status: "bad_request",
		table: v.table,
	})
}

const CONSTRAINTS: Record<string, (v: Violation) => CombError> = {
	"23502": notNull,
	"23503": foreignKey,
	"23505": unique,
	"23514": check,
	"23P01": exclusion,
	P0001: raised,
}

const UNAVAILABLE: Fallback = {
	cause: "Database is temporarily unavailable. Please retry shortly.",
	errorKey: combErrorKeys.DATABASE_UNAVAILABLE,
	status: "service_unavailable",
}
const READONLY: Fallback = {
	cause: "Database is currently in maintenance mode. Please retry shortly.",
	errorKey: combErrorKeys.DATABASE_READONLY,
	status: "service_unavailable",
}
const EXHAUSTED: Fallback = {
	cause: "Database resources exhausted. Please retry your request.",
	errorKey: combErrorKeys.DATABASE_IO_ERROR,
	status: "internal_server_error",
}

/* a serialization failure and a deadlock mean "retry the transaction" by Postgres' own
 * guidance; a statement timeout is the same call under load */
const RETRY: Fallback = {
	cause: "The database could not finish the transaction. Please retry.",
	errorKey: combErrorKeys.DATABASE_UNAVAILABLE,
	status: "service_unavailable",
}

/* resource and availability SQLSTATEs, which a retry or a bigger plan can fix */
const RESOURCE: Record<string, Fallback> = {
	"40001": RETRY,
	"40P01": RETRY,
	"57014": RETRY,
	"08001": UNAVAILABLE,
	"08003": UNAVAILABLE,
	"08004": UNAVAILABLE,
	"08006": UNAVAILABLE,
	"25006": READONLY,
	"53000": EXHAUSTED,
	"53100": {
		cause: "Your plan's database storage limit has been reached. Please upgrade your plan or delete unused data.",
		errorKey: combErrorKeys.STORAGE_LIMIT_REACHED,
		status: "unprocessable_entity",
	},
	"53200": EXHAUSTED,
	/* too many connections, and a server out of them: what a pooler or a serverless plan hits first */
	"53300": UNAVAILABLE,
	"53400": UNAVAILABLE,
	"55P03": RETRY,
	/* a terminated backend, a shutdown, an idle session or transaction the server ended */
	"57P01": UNAVAILABLE,
	"57P02": UNAVAILABLE,
	"57P03": UNAVAILABLE,
	"57P05": UNAVAILABLE,
	"25P03": UNAVAILABLE,
}

/**
 * The CombError a PostgreSQL error is: a constraint violation through the app's maps, a value the
 * column cannot hold as a 400 (value-error.ts), a resource or availability error as its generic
 * key; undefined for anything else. It throws nothing, so a caller can ask what an error is.
 */
function classifyPgError(error: unknown, constraintMaps: ConstraintMap[]): CombError | undefined {
	const read = readPgError(error)
	if (read === null) return undefined
	const handler = own(CONSTRAINTS, read.code)
	const table = mapTable(constraintMaps, read)
	if (handler !== undefined) return handler({ maps: constraintMaps, read, source: error, table })
	const value = valueError(
		read.code,
		{ column: shownColumn(constraintMaps, table, read.column), table: read.table },
		error,
	)
	if (value !== undefined) return value
	const resource = own(RESOURCE, read.code)
	return resource === undefined ? undefined : new CombError({ ...resource, source: error })
}

/** Throw the CombError classifyPgError finds for `error`; anything else is left for the caller */
function pgErrorHandler(error: unknown, constraintMaps: ConstraintMap[]): void {
	const classified = classifyPgError(error, constraintMaps)
	if (classified !== undefined) throw classified
}

export { classifyPgError, pgErrorHandler, type PgErrorRead, readPgError }
