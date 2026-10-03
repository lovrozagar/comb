/**
 * Ordering and keyset predicates — one implementation for every SQLite builder.
 *
 * ORDER BY and the cursor predicate must agree on direction AND null placement
 * for every key, or pagination skips and repeats rows. Both are derived here
 * from the same `SortKey[]`, so they cannot disagree.
 */
import { and, eq, gt, isNotNull, isNull, lt, or, type SQL, type SQLWrapper, sql } from "drizzle-orm"

import { effectiveNulls } from "../cursor.ts"
import type { SortDirection, SortNulls } from "../types.ts"

type SortKey = {
	column: SQLWrapper
	direction: SortDirection
	nulls?: SortNulls | undefined
}

type Tiebreak = {
	column: SQLWrapper
	direction: SortDirection
}

/** `col ASC NULLS LAST` — explicit placement so SQLite's default never leaks in. */
function orderSQL(key: SortKey): SQL {
	const nulls = effectiveNulls(key.direction, key.nulls)
	const dir = sql.raw(key.direction === "asc" ? "ASC" : "DESC")
	const placement = sql.raw(nulls === "first" ? "NULLS FIRST" : "NULLS LAST")
	return sql`${key.column} ${dir} ${placement}`
}

/** ORDER BY for the keys followed by the tiebreak, which makes the order total. */
function orderByKeys(keys: readonly SortKey[], tiebreak: Tiebreak): SQL[] {
	return [...keys.map(orderSQL), orderSQL({ column: tiebreak.column, direction: tiebreak.direction })]
}

function equalTo(key: SortKey, value: unknown): SQL {
	return value === null || value === undefined ? isNull(key.column) : (eq(key.column, value) as SQL)
}

/** Rows strictly after `value` on this key alone; null when none can be. */
function after(key: SortKey, value: unknown): SQL | null {
	const nulls = effectiveNulls(key.direction, key.nulls)
	if (value === null || value === undefined) {
		/* At a null: non-null values come after only when nulls sort first. */
		return nulls === "first" ? isNotNull(key.column) : null
	}
	const beyond = (key.direction === "asc" ? gt(key.column, value) : lt(key.column, value)) as SQL
	return nulls === "last" ? (or(beyond, isNull(key.column)) as SQL) : beyond
}

/**
 * Lexicographic "after this row" over every key plus the tiebreak:
 *
 *   (k1 after) OR (k1 = v1 AND k2 after) OR … OR (k1 = v1 AND … AND id after)
 *
 * Expanded rather than a row-value comparison because each key carries its own
 * direction and null placement.
 */
function keysetSQL(keys: readonly SortKey[], values: readonly unknown[], tiebreak: Tiebreak, id: unknown): SQL {
	const branches: SQL[] = []
	const prefix: SQL[] = []

	keys.forEach((key, index) => {
		const value = values[index]
		const step = after(key, value)
		if (step) branches.push(prefix.length > 0 ? (and(...prefix, step) as SQL) : step)
		prefix.push(equalTo(key, value))
	})

	const idAfter = (tiebreak.direction === "asc" ? gt(tiebreak.column, id) : lt(tiebreak.column, id)) as SQL
	branches.push(prefix.length > 0 ? (and(...prefix, idAfter) as SQL) : idAfter)

	return branches.length === 1 ? (branches[0] as SQL) : (or(...branches) as SQL)
}

export { keysetSQL, orderByKeys, orderSQL, type SortKey, type Tiebreak }
