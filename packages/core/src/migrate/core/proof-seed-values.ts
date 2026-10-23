/**
 * The proof seed's values (proof-seed.ts): six slots per affinity, chosen so a change shows, made
 * each column's own by its position; an INTEGER key's moved past any id a migration writes; a
 * column checked `IN (…)` takes its listed values; a reseed's never meet the first seed's. Text
 * holds outer whitespace and an empty string, so a trim or a NULLIF shows; BLOB slots are bytes.
 * The shapes a CHECK commonly asks for are each affinity's fallbacks: JSON, an email, a UUID, a
 * hex digest and digits for text, a ratio in [0, 1] for reals, epoch milliseconds for integers.
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
	/** its position among the table's nullable columns, which sets the rows that leave it NULL; -1 for any other */
	nullOrdinal: number
	/** a column of the primary key, whose INTEGER values start past 2^40 */
	key: boolean
	type: string
	/** a column of the primary key or a UNIQUE index: each row keeps its own slot, whatever it falls back to */
	unique: boolean
}
/* by affinity: slots 0 to 2 for rows 1 to 3, slot 3 for row 0 where a column has no default, slots 4 and 5 for rows 4 and 5 when a duplicate is refused */
const VALUES: Readonly<Record<string, readonly unknown[]>> = {
	/* two bytes each, as valueFor writes them */
	BLOB: [0x0007, 0x4d63, 0xc3b1, 0x0100, 0x0099, 0x1000],
	INTEGER: [7, -1, 2_147_483_648, 42, 99, 100],
	NUMERIC: [10, 2.5, "x7", 3, 99, 100],
	REAL: [1.5, -0.25, 1e10, 3.25, 9.5, 10.5],
	/* slot 3, a column's value in row 0 when it has no default, is empty; rows 4 and 5, which leave
	   alternate columns NULL, hold outer whitespace in the others */
	TEXT: ["007", "Mixed Case", "ñandú Ü", "", " x ", " zZ "],
}
/**
 * Each row's slot: row 0 slot 3, rows 1 to 3 slots 0 to 2, and each pair of NULL rows after them
 * slots 4 and 5 (proof-seed.ts)
 */
const slotOf = (row: number): number => (row === 0 ? 3 : row < 4 ? row - 1 : 4 + ((row - 4) % 2))
/* which pair of NULL rows a row is in, which moves its values apart from every other pair's */
const pairOf = (row: number): number => (row < 4 ? 0 : Math.floor((row - 4) / 2))
/* where an INTEGER primary key's values start: past any id a migration writes */
const KEY_BASE = 2 ** 40
/** A number for one row of one column in one seed: the shapes' own, no two alike */
const tag = (row: number, column: number, variant: number): number => row + column * 64 + variant * 65_536
/* the shapes a CHECK commonly asks for, by affinity, each the row's, the column's and the seed's own */
const JSON_SHAPE = (row: number, column: number, variant: number): string =>
	JSON.stringify({ c: column, r: row, v: variant })
const RATIO = (row: number, column: number, variant: number): number => (row + 1) / 64 + variant / 128 + column / 1e6
const EPOCH_MS = (row: number, column: number, variant: number): number => 1_700_000_000_000 + tag(row, column, variant)
type Shape = (row: number, column: number, variant: number) => unknown
// lookup-table: each affinity's fallback shapes, tried in order
const SHAPES: Readonly<Record<string, readonly Shape[]>> = {
	BLOB: [(row, column, variant) => bytes(0xb0, row, column % 256, variant)],
	INTEGER: [EPOCH_MS],
	NUMERIC: [RATIO, EPOCH_MS, (row, column, variant) => bytes(0xb0, row, column % 256, variant)],
	REAL: [RATIO],
	TEXT: [
		JSON_SHAPE,
		(row, column, variant) => `r${row}c${column}v${variant}@seed.test`,
		(row, column, variant) => tag(row, column, variant).toString(36).padStart(26, "z"),
		(row, column, variant) => `00000000-0000-4000-8000-${tag(row, column, variant).toString(16).padStart(12, "0")}`,
		(row, column, variant) => tag(row, column, variant).toString(16).padStart(64, "a"),
		(row, column, variant) => String(10_000 + (tag(row, column, variant) % 90_000)),
	],
}
/** The most shapes any affinity has: how many shape attempts a row makes */
const shapeCount = (): number => Math.max(...Object.values(SHAPES).map((shapes) => shapes.length))
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

/** A BLOB value of `values` */
function bytes(...values: number[]): Uint8Array {
	return Uint8Array.from(values)
}

/**
 * `value` made the column's own: a string gains its position's digits before any trailing
 * whitespace, so outer whitespace stays (an empty string stays empty), bytes gain the position's,
 * and a number moves a thousand per position away from zero, so it keeps the sign, size and kind
 * that make it discriminating
 */
function ownValue(value: unknown, index: number): unknown {
	if (index === 0) return value
	if (typeof value === "string") return value === "" ? value : value.replace(/(\s*)$/, `${index}$1`)
	if (value instanceof Uint8Array) return bytes(...value, index % 256, Math.floor(index / 256))
	const number = value as number
	return number + (number < 0 ? -1 : 1) * index * 1000
}

/**
 * The value an attempt gives `column`: its listed values (rotated by its position), a text shape,
 * or its affinity's slot, made the column's own unless the attempt is plain; an INTEGER key's past 2^40
 */
function valueFor(column: Column, at: Attempt & { variant: number }, listed: readonly unknown[] | undefined): unknown {
	/* a unique column keeps the row's own slot, so no fallback repeats another row's value */
	const slot = column.unique ? slotOf(at.row) : at.slot
	if (listed !== undefined && listed.length > 0) return listed[(slot + 1 + column.index) % listed.length]
	const affinity = affinityOf(column.type)
	const shape = at.shape === undefined ? undefined : SHAPES[affinity]?.[at.shape]
	if (shape !== undefined) return shape(at.row, column.index, at.variant)
	const slotted = (VALUES[affinity] as readonly unknown[])[slot]
	const raw = affinity === "BLOB" ? bytes((slotted as number) >> 8, (slotted as number) & 0xff) : slotted
	/* a reseed moves each column's values by 50 positions, so none is one the first seed held */
	/* each later pair of NULL rows moves its values by 200 positions, so none repeats down a column */
	const pair = pairOf(at.row) * 200
	const value = at.plain ? ownValue(raw, pair) : ownValue(raw, column.index + at.variant * 50 + pair)
	if (!column.key || affinity !== "INTEGER") return value
	const number = value as number
	const base = KEY_BASE * (1 + at.variant)
	return number < 0 ? number - base : number + base
}

export { type Attempt, type Column, JSON_SHAPE, listedValues, shapeCount, slotOf, valueFor }
