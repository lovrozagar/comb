/** What codegen reads of a drizzle column beside its comb record: its unique name, its default and its dimensions */
import { type Column, getTableName, is, type Table } from "drizzle-orm"
import { PgTable } from "drizzle-orm/pg-core"
import { pgObjectName } from "../../identifier.ts"

/** A drizzle column with the config fields codegen reads, which drizzle keeps off its public type */
export type ReadColumn = Column & {
	autoIncrement?: boolean | undefined
	defaultFn?: unknown
	dimensions?: number | null | undefined
	generated?: unknown
	generatedIdentity?: unknown
	isUnique?: boolean | undefined
	length?: number | undefined
	onUpdateFn?: unknown
	precision?: number | undefined
	table: Table
	uniqueName?: string | undefined
}

/**
 * The name an unnamed `.unique()` has in the database: drizzle-kit writes it named on SQLite, and as
 * a bare UNIQUE on Postgres, which Postgres names `<table>_<column>_key`
 */
export const unnamedUnique = (column: ReadColumn): string =>
	is(column.table, PgTable)
		? pgObjectName(getTableName(column.table), column.name, "key")
		: `${getTableName(column.table)}_${column.name}_unique`

/**
 * Whether a write that leaves the column out still fills it: a default, a default or update
 * function, an identity, or a Postgres serial. Not drizzle's own hasDefault, which an SQLite
 * integer key has for its rowid, a value the engine fills only when none is given
 */
export const filledByDefault = (column: ReadColumn): boolean =>
	column.default !== undefined ||
	column.defaultFn !== undefined ||
	column.onUpdateFn !== undefined ||
	column.generatedIdentity !== undefined ||
	/^Pg(?:Big|Small)?Serial/.test(column.columnType)

/** A Postgres array's dimensions, which drizzle reads from `.array("[][]")`; an error for one it could not read */
export function dimensionsOf(column: ReadColumn, at: string): number {
	const dimensions = column.dimensions ?? 0
	if (Number.isInteger(dimensions) && dimensions >= 0) return dimensions
	throw new Error(`${at}: drizzle could not read its array dimensions; write .array() or .array("[][]")`)
}
