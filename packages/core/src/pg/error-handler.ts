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
	/** a foreign key violation of a row others still reference (a delete or a key update), not of a missing parent */
	referenced: boolean
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
			/* anchored on the tail Postgres writes after the key values, which a value can spell */
			referenced: /\) is still referenced from table "(?:[^"]|"")+"\.$/.test(text(f.detail) ?? ""),
			table: text(f.table) ?? text(f.table_name),
		}
	}
	return null
}

type Violation = { maps: ConstraintMap[]; read: PgErrorRead; source: unknown }

const toError = (v: Violation, found: Found) => toCombError(found, v.source)

/** `name` cut to at most `bytes` UTF-8 bytes, never inside a character */
function truncateUtf8(name: string, bytes: number): string {
	let out = ""
	let used = 0
	for (const char of name) {
		used += new TextEncoder().encode(char).length
		if (used > bytes) break
		out += char
	}
	return out
}

/* Postgres names a primary key `<table>_pkey`, the table cut so the whole fits its 63-byte identifiers */
const pkeyOf = (table: string) => `${truncateUtf8(table, 58)}_pkey`

function unique(v: Violation): CombError {
	const { constraint, keyColumns: columns, table } = v.read
	if (constraint !== undefined && table !== undefined && constraint === pkeyOf(table)) return primaryKey(v)
	/* a composite unique is keyed by its columns together; one column alone would blame half the pair */
	const column = columns.length === 1 ? columns[0] : undefined
	const entry = lookup(v.maps, table, (t) => own(t.unique, columns.join(",")) ?? own(t.unique, constraint))
	const named = columns.map((c) => (table === undefined ? c : `${table}.${c}`)).join(", ")
	const cause = named === "" ? "Duplicate value detected" : `Duplicate value for ${named}`
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
	const { constraint, keyColumns: columns, referenced, table } = v.read
	/* the key named is the parent's, on a child's constraint: nothing in the map describes it */
	if (referenced) {
		const fallback = {
			cause: "The record is still referenced by other records",
			errorKey: combErrorKeys.FOREIGN_KEY_VIOLATION,
			status: "conflict",
		} as const
		return toError(v, { entry: undefined, fallback, table })
	}
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

/*
 * a value the column cannot hold: a number out of its range, text that is no number, a date that
 * does not parse or is out of range; what a request can send, so a 400. The rest of class 22
 * (a division by zero, say) comes from the server's own SQL and stays the caller's.
 */
// lookup-table: the four SQLSTATEs above, read only
const INVALID_VALUE = /* @__PURE__ */ new Set(["22003", "22P02", "22007", "22008"])

/** A value the column cannot hold, named by its column when the server says which; never echoed */
const invalidValue = ({ column, table }: PgErrorRead, source: unknown) =>
	new CombError({
		cause: column === undefined ? "Invalid value" : `Invalid value for ${column}`,
		column,
		errorKey: combErrorKeys.INVALID_VALUE,
		source,
		status: "bad_request",
		table,
	})

/**
 * Handle PostgreSQL errors: constraint violations through the app's maps, a value the column
 * cannot hold to a 400, resource and availability errors to their generic keys. Anything else
 * is left for the caller.
 */
function pgErrorHandler(error: unknown, constraintMaps: ConstraintMap[]): void {
	const read = readPgError(error)
	if (read === null) return
	const handler = own(CONSTRAINTS, read.code)
	if (handler !== undefined) throw handler({ maps: constraintMaps, read, source: error })
	if (INVALID_VALUE.has(read.code)) throw invalidValue(read, error)
	const resource = own(RESOURCE, read.code)
	if (resource !== undefined) throw new CombError({ ...resource, source: error })
}

export { pgErrorHandler }
