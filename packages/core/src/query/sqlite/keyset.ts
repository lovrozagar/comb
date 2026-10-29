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

/** A count as SQL text: a non-negative safe integer, checked, so nothing but digits reaches sql.raw */
function countText(value: number): string {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`not a count: ${value}`)
	return String(value)
}

/** A count as a SQL literal, where a bound parameter would cost the D1 budget one */
const countLiteral = (value: number): SQL => sql.raw(countText(value))

/** An integer as SQL text, past 2^53 included, its exact digits: checked, so nothing but a sign and digits reaches sql.raw */
function integerText(value: number): string {
	if (!Number.isInteger(value)) throw new RangeError(`not an integer: ${value}`)
	return BigInt(value).toString()
}

/** An integer a JS number holds as a SQL literal, where a bound parameter would cost the D1 budget one (Q15 of r17) */
const integerLiteral = (value: number): SQL => sql.raw(integerText(value))

/**
 * A bound the keyset reads from the cursor's own row (cursor-ref.ts) rather than binds: a long text
 * value carried by reference, or a seconds-mode timestamp, whose fraction no Date holds (`row`); or
 * a SQLite number the cursor carried as null, which may be a ±Infinity D1 hands over as null. Each is SQL that binds, so the keyset reads it twice at most;
 * `ends` when a NULL bound means no bound is safe, and the list ends there.
 */
class AnchorBound {
	readonly ends: boolean
	readonly kind: "infinite" | "row"
	readonly value: SQL

	constructor(kind: "infinite" | "row", value: SQL, ends = false) {
		this.ends = ends
		this.kind = kind
		this.value = value
	}
}

function equalTo(key: SortKey, value: unknown): SQL {
	if (value instanceof AnchorBound)
		return value.kind === "infinite" ? sql`${key.column} IS ${value.value}` : (eq(key.column, value.value) as SQL)
	return value === null || value === undefined ? isNull(key.column) : (eq(key.column, value) as SQL)
}

/**
 * Rows after an infinite bound, NULL or ±Infinity, in one comparison: the key and whether it is
 * NULL as a row value, the flag first, so the bound is read once whichever it holds
 */
function afterInfinite(key: SortKey, bound: AnchorBound): SQL {
	const nulls = effectiveNulls(key.direction, key.nulls)
	/* NULLs are last ascending and first descending exactly when they flag 1 in the row's order */
	const flag = sql.raw((nulls === "last") === (key.direction === "asc") ? "IS NULL" : "IS NOT NULL")
	const op = sql.raw(key.direction === "asc" ? ">" : "<")
	return sql`(${key.column} ${flag}, ${key.column}) ${op} (SELECT comb_bound ${flag}, comb_bound FROM (SELECT ${bound.value} AS comb_bound))`
}

/** Rows strictly after `value` on this key alone; null when none can be. */
function after(key: SortKey, value: unknown): SQL | null {
	if (value instanceof AnchorBound && value.kind === "infinite") return afterInfinite(key, value)
	const nulls = effectiveNulls(key.direction, key.nulls)
	if (value === null || value === undefined) {
		/* At a null: non-null values come after only when nulls sort first. */
		return nulls === "first" ? isNotNull(key.column) : null
	}
	const bound = value instanceof AnchorBound ? value.value : value
	const beyond = (key.direction === "asc" ? gt(key.column, bound) : lt(key.column, bound)) as SQL
	return nulls === "last" ? (or(beyond, isNull(key.column)) as SQL) : beyond
}

/** Where a cursor points: the sort keys and the row's values for them, then the tiebreak and its id */
type KeysetPosition = {
	id: unknown
	keys: readonly SortKey[]
	tiebreak: Tiebreak
	values: readonly unknown[]
}

const anyOf = (branches: readonly SQL[]): SQL =>
	branches.length === 1 ? (branches[0] as SQL) : (or(...branches) as SQL)

/**
 * "After this row" over the keys from `start`, the earlier ones equal: flat, so each value repeats
 * in every later branch, until a bound read from the row, where it nests so that bound is read twice
 *
 *   (k1 after) OR (k1 = v1 AND k2 after) OR (k1 = v1 AND k2 = v2 AND (k3 after OR (k3 = v3 AND …)))
 */
function afterFrom(position: KeysetPosition, start: number): SQL {
	const { id, keys, tiebreak, values } = position
	const branches: SQL[] = []
	const prefix: SQL[] = []
	const within = (step: SQL) => (prefix.length > 0 ? (and(...prefix, step) as SQL) : step)
	for (let index = start; index < keys.length; index++) {
		const key = keys[index] as SortKey
		const value = values[index]
		if (value instanceof AnchorBound) {
			const rest = and(equalTo(key, value), afterFrom(position, index + 1)) as SQL
			/* a bound read from the row is never a bare null, so some row can follow it */
			branches.push(within(or(after(key, value) as SQL, rest) as SQL))
			return anyOf(branches)
		}
		const step = after(key, value)
		if (step) branches.push(within(step))
		prefix.push(equalTo(key, value))
	}
	branches.push(within((tiebreak.direction === "asc" ? gt(tiebreak.column, id) : lt(tiebreak.column, id)) as SQL))
	return anyOf(branches)
}

/** The NULL checks of each bound with no safe fallback: one is NULL once its anchor row is gone or renamed */
const unsafeBounds = (values: readonly unknown[]): SQL[] =>
	values.flatMap((value) => (value instanceof AnchorBound && value.ends ? [isNull(value.value)] : []))

/**
 * Lexicographic "after this row" over every key plus the tiebreak, expanded rather than a row-value
 * comparison because each key carries its own direction and null placement. A bound that `ends`
 * is NULL once its anchor is gone: every row passes then, each carrying anchorGone's flag, so the
 * page answers invalid_cursor rather than end the list unseen (U26).
 */
function keysetSQL(position: KeysetPosition): SQL {
	const unsafe = unsafeBounds(position.values)
	const seek = afterFrom(position, 0)
	return unsafe.length > 0 ? (or(...unsafe, seek) as SQL) : seek
}

/**
 * 1 where a bound with no safe fallback is NULL, its anchor row gone or renamed, else 0; undefined
 * when no bound can be. It reads the anchor row alone, so Postgres plans it once a query (U26).
 */
function anchorGone(values: readonly unknown[]): SQL | undefined {
	const unsafe = unsafeBounds(values)
	return unsafe.length === 0 ? undefined : sql`CASE WHEN ${or(...unsafe)} THEN 1 ELSE 0 END`
}

export {
	AnchorBound,
	anchorGone,
	countLiteral,
	integerLiteral,
	type KeysetPosition,
	keysetSQL,
	orderByKeys,
	orderSQL,
	type SortKey,
	type Tiebreak,
}
