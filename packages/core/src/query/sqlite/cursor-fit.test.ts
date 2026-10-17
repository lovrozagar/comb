import { getTableColumns, sql } from "drizzle-orm"
import { blob, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { assertCursorFits } from "./cursor-fit.ts"

const columns = getTableColumns(
	sqliteTable("t", {
		active: integer("active", { mode: "boolean" }),
		big: blob("big", { mode: "bigint" }),
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
	] as const)("rejects a %s cursor value of the wrong type", (column, value) => {
		expect(fits(column, value)).toBe(false)
	})

	it("leaves a SQL expression unchecked: a derived sort has no declared type", () => {
		expect(() => assertCursorFits([sql`lower(name)`], [{ any: 1 }])).not.toThrow()
	})

	it("checks every position, the tiebreak id last", () => {
		expect(() => assertCursorFits([columns.name, columns.count], ["a", "x"])).toThrow()
	})
})
