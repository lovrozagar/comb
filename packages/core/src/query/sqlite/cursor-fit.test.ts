import { getTableColumns, sql } from "drizzle-orm"
import { blob, customType, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { assertCursorFits, boundForKeys, DateKey } from "./cursor-fit.ts"

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

	it("takes on a derived sort only what every driver binds, and a Date only on one declared as time (Q4)", () => {
		for (const value of ["a", 1, true, null]) expect(() => assertCursorFits([sql`lower(name)`], [value])).not.toThrow()
		for (const value of [new Date(0), { any: 1 }, 1n])
			expect(() => assertCursorFits([sql`length(name)`], [value])).toThrow()
		const at = new DateKey(sql`max(created_at)`)
		expect(() => assertCursorFits([at], [new Date(0)])).not.toThrow()
		expect(() => assertCursorFits([at], [0])).toThrow()
		expect(boundForKeys([at, sql`x`], [new Date(5), new Date(6)])).toEqual([5, new Date(6)])
		expect(at.getSQL()).toBe(at.expression.getSQL())
	})

	it("checks every position, the tiebreak id last", () => {
		expect(() => assertCursorFits([columns.name, columns.count], ["a", "x"])).toThrow()
	})
})
