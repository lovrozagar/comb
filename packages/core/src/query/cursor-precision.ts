/**
 * A sort key at the precision its cursor carries. A Postgres `timestamp` in date mode keeps
 * microseconds (precision 6 unless set) while its cursor, a JS Date, keeps milliseconds, so it is
 * ordered and compared at milliseconds and the id breaks the tie among rows of one millisecond.
 */
import { type SQLWrapper, sql } from "drizzle-orm"

import { AnchorBound, type SortKey } from "./sqlite/keyset.ts"

/** `column` as a cursor compares it: a finer Postgres timestamp truncated to milliseconds */
function cursorPrecision(column: SQLWrapper): SQLWrapper {
	const { columnType, precision } = column as { columnType?: unknown; precision?: unknown }
	if (columnType !== "PgTimestamp" || (typeof precision === "number" && precision <= 3)) return column
	return sql`date_trunc('milliseconds', ${column})`
}

/** The keys as they order and seek: each at the precision its cursor carries */
const atCursorPrecision = (keys: readonly SortKey[]): SortKey[] =>
	keys.map((key) => ({ ...key, column: cursorPrecision(key.column) }))

/**
 * The cursor's values as the keys compare them: a value compared with a truncated key is bound
 * through its column, as a comparison with the column itself binds it (a JS Date as the driver
 * writes that column), so the expression around the column changes nothing about the value; a
 * bound read from the row (cursor-ref.ts) reads it at that precision already
 */
const boundAs = (keys: readonly SortKey[], values: readonly unknown[]): unknown[] =>
	values.map((value, i) => {
		const column = keys[i]?.column as SQLWrapper
		return value === null || value === undefined || value instanceof AnchorBound || cursorPrecision(column) === column
			? value
			: sql.param(value, column as never)
	})

export { atCursorPrecision, boundAs, cursorPrecision }
