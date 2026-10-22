import { Param, SQL } from "drizzle-orm"
import { integer, pgTable, timestamp } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { atCursorPrecision, boundAs, cursorPrecision } from "./cursor-precision.ts"

const t = pgTable("t", {
	fine: timestamp("fine", { precision: 6 }),
	id: integer("id"),
	milli: timestamp("milli", { precision: 3 }),
	plain: timestamp("plain"),
})

describe("cursorPrecision", () => {
	it("truncates a Postgres timestamp finer than milliseconds, and leaves every other key as it is", () => {
		expect(cursorPrecision(t.fine)).toBeInstanceOf(SQL)
		expect(cursorPrecision(t.plain)).toBeInstanceOf(SQL)
		expect(cursorPrecision(t.milli)).toBe(t.milli)
		expect(cursorPrecision(t.id)).toBe(t.id)
	})
})

describe("atCursorPrecision and boundAs", () => {
	it("orders a fine key truncated, and binds its value through the column; a plain key and null as they are", () => {
		const keys = [
			{ column: t.fine, direction: "asc" as const },
			{ column: t.id, direction: "asc" as const },
			{ column: t.fine, direction: "desc" as const },
		]
		const [fine, id] = atCursorPrecision(keys)
		expect(fine?.column).toBeInstanceOf(SQL)
		expect(id?.column).toBe(t.id)
		const at = new Date(5)
		const [bound, seven, missing] = boundAs(keys, [at, 7, null])
		expect(bound).toBeInstanceOf(Param)
		expect(seven).toBe(7)
		expect(missing).toBeNull()
	})
})
