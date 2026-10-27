import { SQL } from "drizzle-orm"
import { integer, pgTable, timestamp } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { cursorPrecision } from "./cursor-precision.ts"

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
