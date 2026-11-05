/**
 * SQLite's columns whose drizzle mode reads a value as another than SQLite stored. A non-STRICT
 * table lets any column hold any storage class: a timestamp TEXT, as a CURRENT_TIMESTAMP default or a
 * datetime() writer stores it, which drizzle reads as an invalid Date and SQLite orders after every
 * number, a boolean any value, which drizzle reads as false but for 1,
 * a `numeric()` ±Infinity or a BLOB, a buffer blob TEXT. Each mode has the classes
 * it reads back as stored (storedReads), and a list carries any other apart. A Postgres date-mode
 * time carries its text the same way, as a Date keeps milliseconds of its microseconds (carriedText).
 */
import { Column, is, type SQLWrapper } from "drizzle-orm"
import { SQLiteColumn } from "drizzle-orm/sqlite-core"

/** Whether `column` is a seconds-mode SQLite timestamp: drizzle binds a Date there floored to the second */
const inSeconds = (column: SQLWrapper | undefined): boolean =>
	is(column, SQLiteColumn) &&
	column.columnType === "SQLiteTimestamp" &&
	(column as unknown as { mode?: unknown }).mode === "timestamp"

/** Whether `column` is a milliseconds-mode SQLite timestamp, whose TEXT drizzle reads as a Date too */
const inMilliseconds = (column: SQLWrapper | undefined): boolean =>
	is(column, SQLiteColumn) &&
	column.columnType === "SQLiteTimestamp" &&
	(column as unknown as { mode?: unknown }).mode === "timestamp_ms"

/**
 * Whether `column` is a SQLite timestamp, which a non-STRICT table lets hold TEXT (a CURRENT_TIMESTAMP
 * default, a datetime() writer): a list that reads the key back carries a TEXT row's text, which its
 * cursor binds as itself, by reference past the cap
 */
const holdsText = (column: SQLWrapper | undefined): boolean => inSeconds(column) || inMilliseconds(column)

/**
 * Whether `value` is the text a list that reads `column` back carried from its row, which the cursor
 * flags (`carried`) and binds as itself, past the column's Date mapper: a Postgres date-mode time's
 * to_json text, which a Date holds to the millisecond; a list that binds the key as
 * read carries none. A SQLite column's stored value is carriedStored's
 */
const carriedText = (
	column: SQLWrapper | undefined,
	value: unknown,
	{ asRead, carried }: { asRead: boolean; carried: boolean },
): boolean =>
	carried &&
	!asRead &&
	typeof value === "string" &&
	!is(column, SQLiteColumn) &&
	is(column, Column) &&
	column.dataType === "object date"

// What each SQLite drizzle mode reads back as stored, as the storage class typeof() names
/**
 * The storage classes a SQLite column's mode reads back as SQLite stored them, a REAL alone when
 * finite (`finite`): a number mode's and a timestamp's integers and REALs, a ±Infinity read as itself,
 * as null with its class beside it or as an Invalid Date a list reads back by its row or its
 * class; a `numeric()`'s integers and finite REALs, as drizzle reads ±Infinity as
 * "Infinity", which binds as TEXT; a text's TEXT; a buffer or bigint
 * blob's BLOB. A boolean reads back NULL, 0 and 1 alone. A JSON mode holds nothing a
 * cursor carries, and a custom column's read is its own mapper's, so neither has a set
 */
type StoredReads = "boolean" | readonly ("blob" | "finite" | "integer" | "real" | "text")[]

// lookup-table: each SQLite drizzle columnType and the storage classes it reads back as stored
const READS: Readonly<Record<string, StoredReads>> = {
	SQLiteBigInt: ["blob"],
	SQLiteBlobBuffer: ["blob"],
	SQLiteBoolean: "boolean",
	SQLiteInteger: ["integer", "real"],
	SQLiteNumeric: ["integer", "finite"],
	SQLiteNumericBigInt: ["integer", "finite"],
	SQLiteNumericNumber: ["integer", "finite"],
	SQLiteReal: ["integer", "real"],
	SQLiteText: ["text"],
	SQLiteTimestamp: ["integer", "real"],
}

/** What `column`'s mode reads back as stored (StoredReads); undefined for no SQLite column, or one with no set */
const storedReads = (column: SQLWrapper | undefined): StoredReads | undefined =>
	is(column, SQLiteColumn) ? READS[column.columnType] : undefined

/**
 * Whether a list that reads `column`'s key back carries its row's stored value apart
 * (`_combTextKeys`) where the column's mode reads it as another (storedReads), which the cursor binds
 * as itself: a SQLite column of a mode with a set
 */
const heldApart = (column: SQLWrapper | undefined): boolean => storedReads(column) !== undefined

/**
 * Whether `value` is the stored value a list that reads `column` back carried apart (heldApart), which
 * the cursor flags (`carried`) and binds as itself: a number, a bigint, a TEXT or a blob's bytes; a
 * list that binds the key as read carries none
 */
const carriedStored = (
	column: SQLWrapper | undefined,
	value: unknown,
	{ asRead, carried }: { asRead: boolean; carried: boolean },
): boolean =>
	carried &&
	!asRead &&
	heldApart(column) &&
	(["bigint", "number", "string"].includes(typeof value) || value instanceof Uint8Array)

export { carriedStored, carriedText, heldApart, holdsText, inMilliseconds, inSeconds, type StoredReads, storedReads }
