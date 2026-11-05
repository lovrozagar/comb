/**
 * SQLite's timestamp columns, by drizzle mode. A non-STRICT table lets one hold TEXT, as a
 * CURRENT_TIMESTAMP default or a datetime() writer stores it, which drizzle reads as an invalid Date
 * and SQLite orders after every number (B2-3 of area B).
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

export { carriedText, holdsText, inMilliseconds, inSeconds }
