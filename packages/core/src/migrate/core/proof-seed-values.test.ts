import { describe, expect, it } from "vitest"
import { type Column, JSON_SHAPE, listedValues, slotOf, valueFor } from "./proof-seed-values.ts"

const column = (over: Partial<Column> = {}): Column => ({
	hasDefault: false,
	index: 1,
	insertable: true,
	key: false,
	name: "c",
	nullable: true,
	nullOrdinal: 0,
	type: "TEXT",
	unique: false,
	...over,
})
const at = (over: Record<string, unknown> = {}) => ({
	defaults: false,
	fallback: false,
	plain: false,
	row: 1,
	slot: 0,
	variant: 0,
	...over,
})

describe("valueFor", () => {
	it("makes a slot's value the column's own, or plain", () => {
		expect(valueFor(column(), at(), undefined)).toBe("0071")
		expect(valueFor(column({ type: "INTEGER" }), at(), undefined)).toBe(1007)
		expect(valueFor(column({ type: "INTEGER" }), at({ plain: true }), undefined)).toBe(7)
	})

	it("moves an INTEGER key past 2^40, keeping its sign, and a reseed's further", () => {
		const key = column({ index: 0, key: true, type: "INTEGER", unique: true })
		expect(valueFor(key, at({ row: 2, slot: 1 }), undefined)).toBe(-1 - 2 ** 40)
		expect(valueFor(key, at({ row: 1 }), undefined)).toBe(7 + 2 ** 40)
		expect(valueFor(key, at({ row: 1, variant: 1 }), undefined)).toBe(50_007 + 2 * 2 ** 40)
	})

	it("keeps a unique column on its row's own slot, takes a shape, and a listed value", () => {
		expect(valueFor(column({ unique: true }), at({ row: 4, slot: 0 }), undefined)).toBe(
			valueFor(column(), at({ row: 4, slot: slotOf(4) }), undefined),
		)
		expect(valueFor(column(), at({ plain: true, shape: 1 }), undefined)).toBe("r1c1v0@seed.test")
		expect(valueFor(column(), at({ plain: true, shape: 3 }), undefined)).toHaveLength(36)
		expect(valueFor(column(), at({ plain: true, shape: 4 }), undefined)).toMatch(/^[0-9a-f]{64}$/)
		expect(valueFor(column(), at({ plain: true, shape: 5 }), undefined)).toMatch(/^\d{5}$/)
		/* M11: each affinity's own shapes, a ratio in [0, 1], epoch milliseconds and bytes among them */
		expect(valueFor(column({ type: "INTEGER" }), at({ shape: 0 }), undefined)).toBe(1_700_000_000_065)
		expect(valueFor(column({ type: "REAL" }), at({ shape: 0 }), undefined)).toBe(2 / 64 + 1 / 1e6)
		expect(valueFor(column({ type: "" }), at({ shape: 0 }), undefined)).toEqual(Uint8Array.from([0xb0, 1, 1, 0]))
		expect(valueFor(column({ type: "NUMERIC" }), at({ shape: 2 }), undefined)).toEqual(Uint8Array.from([0xb0, 1, 1, 0]))
		/* a shape the affinity has none of falls back to its slot */
		expect(valueFor(column({ type: "REAL" }), at({ shape: 3 }), undefined)).toBe(1.5 + 1000)
		expect(valueFor(column(), at(), ["a", "b"])).toBe("a")
	})

	it("gives a reseed values the first seed never held", () => {
		expect(valueFor(column(), at({ variant: 1 }), undefined)).not.toBe(valueFor(column(), at(), undefined))
	})
})

describe("listedValues", () => {
	it("reads a CHECK … IN list, strings and numbers, and nothing for an unchecked column", () => {
		expect(
			listedValues("CREATE TABLE t (k TEXT CHECK (k IN ('a', 'it''s')), n INT CHECK (n IN (1, -2.5)))", "k"),
		).toEqual(["a", "it's"])
		expect(
			listedValues("CREATE TABLE t (k TEXT CHECK (k IN ('a', 'it''s')), n INT CHECK (n IN (1, -2.5)))", "n"),
		).toEqual([1, -2.5])
		expect(listedValues("CREATE TABLE t (k TEXT)", "k")).toBeUndefined()
	})
})

/* P2 of the 2.4 review: a JSON value is its column's own and its seed's own */
describe("the seed's JSON", () => {
	it("differs between columns of a row, and between the first seed and a reseed", () => {
		expect(JSON_SHAPE(1, 2, 0)).not.toBe(JSON_SHAPE(1, 3, 0))
		expect(JSON_SHAPE(1, 2, 0)).not.toBe(JSON_SHAPE(1, 2, 1))
		expect(JSON.parse(JSON_SHAPE(1, 2, 1))).toEqual({ c: 2, r: 1, v: 1 })
	})
})
