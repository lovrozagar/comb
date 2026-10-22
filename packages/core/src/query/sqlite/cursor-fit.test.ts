import { getTableColumns, sql } from "drizzle-orm"
import { blob, customType, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { assertCursorFits, bindable, boundForKeys, DateKey } from "./cursor-fit.ts"

const columns = getTableColumns(
	sqliteTable("t", {
		active: integer("active", { mode: "boolean" }),
		big: blob("big", { mode: "bigint" }),
		blobby: customType<{ data: string; driverData: Uint8Array }>({ dataType: () => "blob" })("blobby"),
		count: integer("count"),
		meta: text("meta", { mode: "json" }),
		name: text("name"),
		score: real("score"),
		seen_at: integer("seen_at", { mode: "timestamp" }),
		status: text("status", { enum: ["a", "b"] }),
	}),
)

const fits = (column: keyof typeof columns, value: unknown) => {
	try {
		assertCursorFits([columns[column]], [value])
		return true
	} catch (error) {
		expect(error).toMatchObject({ errorKey: "invalid_cursor", status: 400 })
		return false
	}
}

describe("assertCursorFits", () => {
	it.each([
		["name", "a"],
		["status", "a"],
		["count", 1],
		["score", 1.5],
		["active", true],
		["seen_at", new Date(1)],
		["meta", null],
		["big", null],
		["big", 1n],
	] as const)("accepts what a %s column holds", (column, value) => {
		expect(fits(column, value)).toBe(true)
	})

	it.each([
		["name", 1],
		["count", "1"],
		["active", 0],
		["seen_at", 1],
		["seen_at", "2024"],
		["meta", { a: 1 }],
		["big", "1"],
		["blobby", "x"],
	] as const)("rejects a %s cursor value of the wrong type", (column, value) => {
		expect(fits(column, value)).toBe(false)
	})

	it("takes on a derived sort only what every driver binds, and on one declared as time a Date or its epoch milliseconds (Q4, R3)", () => {
		for (const value of ["a", 1, true, null, 1n])
			expect(() => assertCursorFits([sql`lower(name)`], [value])).not.toThrow()
		for (const value of [new Date(0), { any: 1 }])
			expect(() => assertCursorFits([sql`length(name)`], [value])).toThrow()
		const at = new DateKey(sql`max(created_at)`)
		/* a row that selected the key as sql<number> holds a number, or a bigint on libsql's bigint mode */
		for (const value of [new Date(0), 0, 1700000000000, 1700000000000n])
			expect(() => assertCursorFits([at], [value])).not.toThrow()
		for (const value of ["2024", Number.NaN, Number.POSITIVE_INFINITY])
			expect(() => assertCursorFits([at], [value])).toThrow()
		expect(boundForKeys([at, sql`x`], [new Date(5), new Date(6)])).toEqual([5, new Date(6)])
		expect(at.getSQL()).toBe(at.expression.getSQL())
	})

	it("takes a bigint on a number column, as libsql's bigint mode and bun:sqlite's safeIntegers return it (R3)", () => {
		expect(() => assertCursorFits([columns.count], [7n])).not.toThrow()
		expect(() => assertCursorFits([columns.count], [9007199254740993n])).not.toThrow()
	})

	it("binds a bigint a number holds exactly as that number, and a larger one as it is", () => {
		expect(bindable(7n)).toBe(7)
		expect(bindable(9007199254740993n)).toBe(9007199254740993n)
		expect(bindable("7")).toBe("7")
		expect(boundForKeys([sql`x`, sql`y`], [7n, 9007199254740993n])).toEqual([7, 9007199254740993n])
	})

	it("checks every position, the tiebreak id last", () => {
		expect(() => assertCursorFits([columns.name, columns.count], ["a", "x"])).toThrow()
	})
})
