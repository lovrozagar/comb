/**
 * PostgreSQL errors mapped to CombErrors, one handler per SQLSTATE. The server's error is found
 * by walking `.cause` past wrappers such as drizzle's; node-postgres, postgres.js and Bun.SQL
 * name its fields differently, and `readPgError` reads all three.
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
import { type Fallback, type Found, findCheck, lookup, own, toCombError } from "../constraint-map.ts"
import { CombError } from "../error.ts"
import { type ConstraintMap, combErrorKeys } from "../types.ts"

export type PgErrorRead = {
	code: string
	column: string | undefined
	constraint: string | undefined
	/** the columns in `detail`'s `Key (a, b)=(…)` */
	keyColumns: string[]
	table: string | undefined
}

const SQLSTATE = /^[0-9A-Z]{5}$/

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)

/** The fields the three drivers put on a server error, under either name. */
type DriverError = {
	cause?: unknown
	code?: unknown
	column?: unknown
	column_name?: unknown
	constraint?: unknown
	constraint_name?: unknown
	detail?: unknown
	errno?: unknown
	table?: unknown
	table_name?: unknown
}

function fields(error: object): DriverError {
	return error as DriverError
}

/** The SQLSTATE of one error: node-postgres and postgres.js put it on `code`, Bun.SQL on `errno`. */
function sqlstate(error: DriverError): string | undefined {
	for (const value of [error.code, error.errno]) if (typeof value === "string" && SQLSTATE.test(value)) return value
	return undefined
}

function keyColumns(detail: string | undefined): string[] {
	const list = /^Key \(([^)]+)\)=/.exec(detail ?? "")?.[1]
	return list === undefined ? [] : list.split(",").map((column) => column.trim().replace(/^"|"$/g, ""))
}

/**
 * The Postgres server error inside `error`, or null when there is none. The chain is read innermost
 * first: the driver's error is the deepest, and a wrapper's own `code` never wins over it.
 */
export function readPgError(error: unknown): PgErrorRead | null {
	const chain: DriverError[] = []
	for (let current: unknown = error; chain.length < 8 && typeof current === "object" && current !== null;) {
		const f = fields(current)
		chain.push(f)
		current = f.cause
	}
	for (const f of chain.toReversed()) {
		const code = sqlstate(f)
		if (code === undefined) continue
		return {
			code,
			column: text(f.column) ?? text(f.column_name),
			constraint: text(f.constraint) ?? text(f.constraint_name),
			keyColumns: keyColumns(text(f.detail)),
			table: text(f.table) ?? text(f.table_name),
		}
	}
	return null
}

type Violation = { maps: ConstraintMap[]; read: PgErrorRead; source: unknown }

const toError = (v: Violation, found: Found) => toCombError(found, v.source)

function unique(v: Violation): CombError {
	const { constraint, keyColumns: columns, table } = v.read
	if (constraint !== undefined && table !== undefined && constraint === `${table}_pkey`) return primaryKey(v)
	const column = columns[0]
	const entry = lookup(v.maps, table, (t) => own(t.unique, column) ?? own(t.unique, constraint))
	const where = column === undefined ? undefined : table === undefined ? column : `${table}.${column}`
	const cause = where === undefined ? "Duplicate value detected" : `Duplicate value for ${where}`
	const fallback = { cause, errorKey: combErrorKeys.UNIQUE_CONSTRAINT_VIOLATION, status: "conflict" } as const
	return toError(v, { column, entry, fallback, table })
}

function primaryKey(v: Violation): CombError {
	const { keyColumns: columns, table } = v.read
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
	const { constraint, keyColumns: columns, table } = v.read
	const column = columns[0]
	const entry = lookup(v.maps, table, (t) => own(t.foreignKey, column) ?? own(t.foreignKey, constraint))
	const fallback = {
		cause: "Referenced record does not exist or is still in use",
		errorKey: combErrorKeys.FOREIGN_KEY_VIOLATION,
		status: "conflict",
	} as const
	return toError(v, { column, entry, fallback, table })
}

function check(v: Violation): CombError {
	const { constraint, table } = v.read
	const fallback = {
		cause: "Data validation failed",
		errorKey: combErrorKeys.CHECK_CONSTRAINT_VIOLATION,
		status: "bad_request",
	} as const
	if (table !== undefined)
		return toError(v, { entry: lookup(v.maps, table, (t) => own(t.check, constraint)), fallback, table })
	const found = findCheck(v.maps, constraint)
	return toError(v, { entry: found?.entry, fallback, table: found?.table })
}

function notNull(v: Violation): CombError {
	const { column, table } = v.read
	return new CombError({
		cause: column === undefined ? "Required field missing" : `Required field missing: ${column}`,
		column,
		errorKey: combErrorKeys.REQUIRED_FIELD_MISSING,
		source: v.source,
		status: "bad_request",
		table,
	})
}

const CONSTRAINTS: Record<string, (v: Violation) => CombError> = {
	"23502": notNull,
	"23503": foreignKey,
	"23505": unique,
	"23514": check,
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
	"57P01": READONLY,
	"57P02": UNAVAILABLE,
	"57P03": UNAVAILABLE,
}

/**
 * Handle PostgreSQL errors: constraint violations through the app's maps, resource and
 * availability errors to their generic keys. Anything else is left for the caller.
 */
function pgErrorHandler(error: unknown, constraintMaps: ConstraintMap[]): void {
	const read = readPgError(error)
	if (read === null) return
	const handler = own(CONSTRAINTS, read.code)
	if (handler !== undefined) throw handler({ maps: constraintMaps, read, source: error })
	const resource = own(RESOURCE, read.code)
	if (resource !== undefined) throw new CombError({ ...resource, source: error })
}

export { pgErrorHandler }
