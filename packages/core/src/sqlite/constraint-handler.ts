/**
 * SQLite constraint violations mapped to CombErrors, one handler per extended result code.
 * Shared by the libsql, bun:sqlite and D1 handlers: the engine is the same, only the way the
 * driver carries the code differs, and `readSqliteError` absorbs that.
 */
import {
	checkedOnce,
	entryOf,
	type Found,
	findNamed,
	lookup,
	own,
	shown,
	shownColumn,
	toCombError,
} from "../constraint-map.ts"
import { connectionLost, UNAVAILABLE } from "../connection-lost.ts"
import { CombError } from "../error.ts"
import { type ConstraintMap, combErrorKeys } from "../types.ts"
import { valueError } from "../value-error.ts"
import { readSqliteError, type SqliteErrorRead } from "./read-error.ts"
import { resourceOutcome } from "./resource-outcome.ts"
import { statementHead, statementTable, updatedColumns, upsertColumns } from "../statement-head.ts"

type Violation = { maps: readonly ConstraintMap[]; read: SqliteErrorRead; source: unknown }

/** The index a UNIQUE violation names instead of columns, when it is on an expression: `index 'u_email_lower'` */
const failedIndex = (message: string): string | undefined => /constraint failed: index '([^']+)'$/i.exec(message)?.[1]

/**
 * A `table.column` pair as SQLite writes it, unquoted: split after the statement's own table when the
 * pair starts with it, as a dot may sit in either name (U13); else after a table a map knows, so a
 * private column with a dot in its name is found under its table (Q19 of r17); else on its last dot
 */
function splitPair(
	pair: string,
	table: string | undefined,
	maps: readonly ConstraintMap[],
): { column: string; table: string } | undefined {
	if (table !== undefined && pair.startsWith(`${table}.`)) return { column: pair.slice(table.length + 1), table }
	const mapped = [...pair.matchAll(/\./g)]
		.map(({ index }) => pair.slice(0, index))
		.find((name) => maps.some((map) => entryOf(map, name) !== undefined))
	if (mapped !== undefined) return { column: pair.slice(mapped.length + 1), table: mapped }
	const at = /^(.+)\.([^.]+)$/.exec(pair)
	return at === null ? undefined : { column: at[2] as string, table: at[1] as string }
}

/**
 * `UNIQUE constraint failed: member.first, member.last` → member, [first, last]. A table name may
 * hold any character, a dot or ", " included: with `query`'s table known, each pair starts at
 * ", <table>." (U44) and splits at that table (splitPair); else at each ", ".
 */
function failedColumns(
	message: string,
	{ maps, query }: { maps: readonly ConstraintMap[]; query: string | undefined },
): { columns: string[]; table: string | undefined } {
	const list = /constraint failed: (.+)$/i.exec(message)?.[1] ?? ""
	const known = statementTable(query)
	const raw =
		known !== undefined && list.startsWith(`${known}.`)
			? list
					.slice(known.length + 1)
					.split(`, ${known}.`)
					.map((column) => `${known}.${column}`)
			: list.split(", ")
	const pairs = raw.map((pair) => splitPair(pair.trim(), known, maps)).filter((pair) => pair !== undefined)
	return { columns: pairs.map((pair) => pair.column), table: pairs[0]?.table }
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
	const { columns, table } = failedColumns(v.read.message, { maps: v.maps, query: v.read.query })
	const named = shown(v.maps, table, columns)
	/* a composite unique is keyed by its columns together; one column alone would blame half the pair */
	const column = named.length === 1 ? named[0] : undefined
	const entry = lookup(v.maps, table, (t) => own(t.unique, columns.join(",")))
	const cause =
		named.length === 0
			? "Duplicate value detected"
			: `Duplicate value for ${named.map((c) => `${table}.${c}`).join(", ")}`
	const fallback = { cause, errorKey: combErrorKeys.UNIQUE_CONSTRAINT_VIOLATION, status: "conflict" } as const
	return toError(v, { column, entry, fallback, table })
}

function primaryKey(v: Violation): CombError {
	const { columns, table } = failedColumns(v.read.message, { maps: v.maps, query: v.read.query })
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
	const { columns, table } = failedColumns(v.read.message, { maps: v.maps, query: v.read.query })
	const column = shownColumn(v.maps, table, columns[0])
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
 * fail on the other side, a row that references the deleted one, so no key of its own is blamed.
 * An UPDATE whose SET list assigns none of the foreign key columns the table's maps list blames no
 * key of its own either (U6), and says neither side: a map need not list every key (U23). */
function foreignKey(v: Violation): CombError {
	const table = statementTable(v.read.query)
	let column: string | undefined
	/* every foreign key column a map lists for the table: none, one or many; undefined when no map lists it */
	let keys: string[] | undefined
	const entry = lookup(v.maps, table, (t) => {
		const listed = Object.keys(t.foreignKey ?? {})
		keys = [...(keys ?? []), ...listed]
		column = listed.length === 1 ? listed[0] : undefined
		return own(t.foreignKey, column)
	})
	const assigned = updatedColumns(v.read.query)
	/* an UPDATE that sets none of the keys a map lists may still have broken one the map leaves out,
	   a composite key's later column among them: which side failed is unknown (U23) */
	const folded = new Set(keys?.map(asciiFolded))
	const unlisted = assigned !== undefined && !assigned.some((name) => folded.has(asciiFolded(name)))
	/* a statement that changes a key other tables reference may have failed on a row that references
	   the old value, its own key valid: which side failed is unknown (U43) */
	const referenced = new Set(v.maps.flatMap((map) => entryOf(map, table)?.referenced ?? []).map(asciiFolded))
	const changesReferenced = (assigned ?? upsertColumns(v.read.query) ?? []).some((name) =>
		referenced.has(asciiFolded(name)),
	)
	if (/^delete\b/i.test(statementHead(v.read.query ?? ""))) {
		const fallback = {
			cause: STILL_REFERENCED,
			errorKey: combErrorKeys.FOREIGN_KEY_VIOLATION,
			status: "conflict",
		} as const
		return toError(v, { entry: undefined, fallback, table })
	}
	const fallback = {
		cause: MISSING_OR_REFERENCED,
		errorKey: combErrorKeys.FOREIGN_KEY_VIOLATION,
		status: "conflict",
	} as const
	if (unlisted || changesReferenced) return toError(v, { entry: undefined, fallback, table })
	return toError(v, {
		column: entry === undefined ? undefined : shownColumn(v.maps, table, column),
		entry,
		fallback,
		table,
	})
}

/**
 * A rule a trigger enforces with RAISE(ABORT | FAIL | ROLLBACK, message): a 400 whose cause is the
 * message the app wrote for it, which every driver reports under SQLITE_CONSTRAINT_TRIGGER. A bare
 * SQLITE_CONSTRAINT whose wording names no kind is a 400 too, with the generic cause: its words
 * may be the engine's, a column's name among them (Q8 of r18), as is a RAISE with no message to
 * show, when D1's exec() quoted the statement before it (Q8 of r17).
 */
const raised = (v: Violation): CombError =>
	new CombError({
		cause:
			v.read.code !== "SQLITE_CONSTRAINT_TRIGGER" || v.read.message === "" ? "Constraint violated" : v.read.message,
		errorKey: combErrorKeys.CONSTRAINT_VIOLATION,
		source: v.source,
		status: "bad_request",
	})

/** `name` with its ASCII letters lowercased: SQLite reads a column name in any ASCII case, and folds no other letter (U42) */
const asciiFolded = (name: string): string => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

const CONSTRAINTS: Record<string, (v: Violation) => CombError> = {
	SQLITE_CONSTRAINT: raised,
	SQLITE_CONSTRAINT_CHECK: check,
	SQLITE_CONSTRAINT_FOREIGNKEY: foreignKey,
	SQLITE_CONSTRAINT_NOTNULL: notNull,
	SQLITE_CONSTRAINT_PRIMARYKEY: primaryKey,
	/* a duplicate rowid, a table's own key (Q11 of r17) */
	SQLITE_CONSTRAINT_ROWID: primaryKey,
	SQLITE_CONSTRAINT_TRIGGER: raised,
	SQLITE_CONSTRAINT_UNIQUE: unique,
}

/** A STRICT mismatch's `cannot store TEXT value in INTEGER column s.n` → s, n */
const mismatchAt = (
	message: string,
	{ maps, query }: { maps: readonly ConstraintMap[]; query: string | undefined },
) => {
	const pair = /\bcolumn (.+)$/.exec(message)?.[1]
	const at = pair === undefined ? undefined : splitPair(pair, statementTable(query), maps)
	return { column: at?.column, table: at?.table }
}

/**
 * The CombError for an SQLite constraint violation inside `error`, or for a value its column
 * cannot hold (value-error.ts); null when it is neither.
 */
function constraintError(error: unknown, given: readonly ConstraintMap[]): CombError | null {
	const maps = checkedOnce(given)
	const read = readSqliteError(error)
	if (read === null) return null
	const handler = own(CONSTRAINTS, read.code)
	if (handler !== undefined) return handler({ maps, read, source: error })
	const at = mismatchAt(read.message, { maps, query: read.query })
	return valueError(read, { column: shownColumn(maps, at.table, at.column), table: at.table }, error) ?? null
}

/**
 * Throws the mapped CombError when `error` is an SQLite constraint violation; otherwise returns.
 * `error` is the thrown error, wrapper and all, or an engine message given as text.
 */
function handleConstraintViolation(error: unknown, maps: readonly ConstraintMap[]): void {
	const mapped = constraintError(error, maps)
	if (mapped !== null) throw mapped
}

/**
 * The CombError a libsql, Turso or bun:sqlite error is: a constraint violation, a resource error,
 * or a lost connection, as on D1 and Postgres (Q11 of r18); undefined for any other. It throws
 * nothing, so a caller can ask what an error is.
 */
function classifySqliteError(error: unknown, maps: readonly ConstraintMap[]): CombError | undefined {
	const constraint = constraintError(error, maps)
	if (constraint !== null) return constraint
	const resource = resourceOutcome(readSqliteError(error)?.code)
	if (resource !== undefined) return new CombError({ ...resource, source: error })
	return connectionLost(error) ? new CombError({ ...UNAVAILABLE, source: error }) : undefined
}

/** The error handler for libsql, Turso and bun:sqlite: throws what classifySqliteError finds; any other error is left for the caller */
function sqliteErrorHandler(error: unknown, maps: readonly ConstraintMap[]): void {
	const classified = classifySqliteError(error, maps)
	if (classified !== undefined) throw classified
}

export { classifySqliteError, constraintError, handleConstraintViolation, resourceOutcome, sqliteErrorHandler }
