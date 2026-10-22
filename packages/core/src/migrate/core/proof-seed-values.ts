/**
 * The proof seed's values (proof-seed.ts): six slots per affinity, chosen so a change shows, made
 * each column's own by its position; an INTEGER key's moved past any id a migration writes; a
 * column checked `IN (…)` takes its listed values; a reseed's never meet the first seed's.
 */
import { affinityOf } from "./sqlite-affinity.ts"

/** A column as the seed fills it */
type Column = {
	hasDefault: boolean
	/** its position in the table, which sets its values apart from every other column's */
	index: number
	insertable: boolean
	name: string
	nullable: boolean
	/** a column of the primary key, whose INTEGER values start past 2^40 */
	key: boolean
	type: string
	/** a column of the primary key or a UNIQUE index: each row keeps its own slot, whatever it falls back to */
	unique: boolean
}
/* by affinity: slots 0 to 2 for rows 1 to 3, slot 3 for row 0 where a column has no default, slots 4 and 5 for rows 4 and 5 when a duplicate is refused */
const VALUES: Readonly<Record<string, readonly unknown[]>> = {
	BLOB: ["007", 7, "Mixed Case", "ñandú Ü", 99, 100],
	INTEGER: [7, -1, 2_147_483_648, 42, 99, 100],
	NUMERIC: [10, 2.5, "x7", 3, 99, 100],
	REAL: [1.5, -0.25, 1e10, 3.25, 9.5, 10.5],
	TEXT: ["007", "Mixed Case", "ñandú Ü", "010", "Zz", "zZ 2"],
}
/* each row's slot */
const FRESH: readonly number[] = [3, 0, 1, 2, 4, 5]
/* where an INTEGER primary key's values start: past any id a migration writes */
const KEY_BASE = 2 ** 40
/* the text shapes a CHECK commonly asks for, row `row`'s own: JSON, an email, a fixed length */
const SHAPES: ReadonlyArray<(row: number) => string> = [
	(row) => `{"r":${row}}`,
	(row) => `r${row}@seed.test`,
	(row) => `${"abcdefghijklmnopqrstuvwxy"}${row}`,
]
/**
 * Which values a row tries: its slot; whether every column with a default takes it; whether the
 * slot's values go in plain (without the column's offset); a text shape; whether it is a fallback,
 * where row 4 takes values instead of NULLs
 */
type Attempt = {
	defaults: boolean
	fallback: boolean
	plain: boolean
	row: number
	shape?: number | undefined
	slot: number
}

/** The values a CREATE TABLE checks a column against with `<column> IN ('a', 'b', …)`, if any */
function listedValues(sql: string, column: string): unknown[] | undefined {
	const name = column.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const listed = new RegExp(`CHECK\\s*\\(\\s*["\`[]?${name}["\`\\]]?\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, "i").exec(sql)?.[1]
	if (listed === undefined) return undefined
	return [...listed.matchAll(/'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)/g)].map((match) =>
		match[1] === undefined ? Number(match[2]) : match[1].replaceAll("''", "'"),
	)
}

/**
 * `value` made the column's own: a string gains its position's digits, a number moves a thousand
 * per position away from zero, so it keeps the sign, size and kind that make it discriminating
 */
function ownValue(value: unknown, index: number): unknown {
	if (index === 0) return value
	if (typeof value === "string") return `${value}${index}`
	const number = value as number
	return number + (number < 0 ? -1 : 1) * index * 1000
}

/**
 * The value an attempt gives `column`: its listed values (rotated by its position), a text shape,
 * or its affinity's slot, made the column's own unless the attempt is plain; an INTEGER key's past 2^40
 */
function valueFor(column: Column, at: Attempt & { variant: number }, listed: readonly unknown[] | undefined): unknown {
	/* a unique column keeps the row's own slot, so no fallback repeats another row's value */
	const slot = column.unique ? (FRESH[at.row] as number) : at.slot
	if (listed !== undefined && listed.length > 0) return listed[(slot + 1 + column.index) % listed.length]
	const affinity = affinityOf(column.type)
	if (at.shape !== undefined && affinity === "TEXT") return (SHAPES[at.shape] as (row: number) => string)(at.row)
	const raw = (VALUES[affinity] as readonly unknown[])[slot]
	/* a reseed moves each column's values by 50 positions, so none is one the first seed held */
	const value = at.plain ? raw : ownValue(raw, column.index + at.variant * 50)
	if (!column.key || affinity !== "INTEGER") return value
	const number = value as number
	const base = KEY_BASE * (1 + at.variant)
	return number < 0 ? number - base : number + base
}

export { type Attempt, type Column, FRESH, listedValues, SHAPES, valueFor }
