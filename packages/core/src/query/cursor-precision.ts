/**
 * A sort key at the precision its cursor carries. A Postgres `timestamp` in date mode keeps
 * microseconds (precision 6 unless set) while its cursor, a JS Date, keeps milliseconds. The key is
 * ordered and sought as the column itself, so an index serves it; this truncation only guards the
 * bound read from the anchor row, which holds the exact value (cursor-ref.ts, U27).
 */
import { type SQLWrapper, sql } from "drizzle-orm"

/** `column` as a cursor compares it: a finer Postgres timestamp truncated to milliseconds */
function cursorPrecision(column: SQLWrapper): SQLWrapper {
	const { columnType, precision } = column as { columnType?: unknown; precision?: unknown }
	if (columnType !== "PgTimestamp" || (typeof precision === "number" && precision <= 3)) return column
	return sql`date_trunc('milliseconds', ${column})`
}

export { cursorPrecision }
