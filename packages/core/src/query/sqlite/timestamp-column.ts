/**
 * SQLite's columns whose drizzle mode reads a value as another than SQLite stored. A non-STRICT
 * table lets a timestamp hold TEXT, as a CURRENT_TIMESTAMP default or a datetime() writer stores it,
 * which drizzle reads as an invalid Date and SQLite orders after every number (B2-3 of area B), and a
 * boolean any value, which drizzle reads as false but for 1 (AB3-2 of area B).
 */
import { is, type SQLWrapper } from "drizzle-orm"
import { SQLiteColumn } from "drizzle-orm/sqlite-core"

/** Whether `column` is a seconds-mode SQLite timestamp: drizzle binds a Date there floored to the second */
const inSeconds = (column: SQLWrapper | undefined): boolean =>
	is(column, SQLiteColumn) &&
	column.columnType === "SQLiteTimestamp" &&
	(column as unknown as { mode?: unknown }).mode === "timestamp"

/** Whether `column` is a milliseconds-mode SQLite timestamp, whose TEXT drizzle reads as a Date too (B2-3 of area B) */
const inMilliseconds = (column: SQLWrapper | undefined): boolean =>
	is(column, SQLiteColumn) &&
	column.columnType === "SQLiteTimestamp" &&
	(column as unknown as { mode?: unknown }).mode === "timestamp_ms"

/**
 * Whether `column` is a SQLite timestamp, which a non-STRICT table lets hold TEXT (a CURRENT_TIMESTAMP
 * default, a datetime() writer): a list that reads the key back carries a TEXT row's text, which its
 * cursor binds as itself, by reference past the cap (B2-3 of area B)
 */
const holdsText = (column: SQLWrapper | undefined): boolean => inSeconds(column) || inMilliseconds(column)

/**
 * Whether `value` is the TEXT a list that reads `column` back carried from its row, which the cursor
 * flags (`carried`) and binds as itself; a list that binds the key as read carries none
 */
const carriedText = (
	column: SQLWrapper | undefined,
	value: unknown,
	{ asRead, carried }: { asRead: boolean; carried: boolean },
): boolean => carried && !asRead && typeof value === "string" && holdsText(column)

/**
 * Whether `column` is a SQLite boolean: drizzle reads every value but 1 as false, where a non-STRICT
 * table holds any, a raw writer's -1 or 2 among them, which SQLite orders apart (AB3-2 of area B)
 */
const inBoolean = (column: SQLWrapper | undefined): boolean =>
	is(column, SQLiteColumn) && column.columnType === "SQLiteBoolean"

/**
 * Whether a list that reads `column`'s key back carries its row's stored value apart
 * (`_combTextKeys`), where the column's read loses it: a timestamp's TEXT or a boolean's any value but 0 or 1
 */
const heldApart = (column: SQLWrapper | undefined): boolean => holdsText(column) || inBoolean(column)

/**
 * Whether `value` is the stored value a list that reads `column` back carried for a SQLite boolean
 * holding a value but 0 or 1, which the cursor flags (`carried`) and binds as itself: a number, a
 * bigint past 2^53, a TEXT or a blob's bytes; a list that binds the key as read carries none
 */
const carriedStored = (
	column: SQLWrapper | undefined,
	value: unknown,
	{ asRead, carried }: { asRead: boolean; carried: boolean },
): boolean =>
	carried &&
	!asRead &&
	inBoolean(column) &&
	(["bigint", "number", "string"].includes(typeof value) || value instanceof Uint8Array)

export { carriedStored, carriedText, heldApart, holdsText, inBoolean, inMilliseconds, inSeconds }
