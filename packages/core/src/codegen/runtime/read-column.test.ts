import { integer as sqliteInteger, sqliteTable, text as sqliteText } from "drizzle-orm/sqlite-core"
import { bigserial, integer, pgTable, serial, smallserial, text } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { dimensionsOf, filledByDefault, type ReadColumn, unnamedUnique } from "./read-column.ts"

const pg = pgTable("orders", {
	bare: text("bare"),
	big: bigserial("big", { mode: "number" }),
	fn: text("fn").$defaultFn(() => "x"),
	grid: integer("grid").array("[][]"),
	id: integer("id").generatedAlwaysAsIdentity(),
	list: integer("list").array(),
	small: smallserial("small"),
	stamped: text("stamped").$onUpdateFn(() => "x"),
	value: text("value").default("x"),
	ws: serial("ws"),
})
const lite = sqliteTable("orders", { id: sqliteInteger("id").primaryKey(), name: sqliteText("name") })
const read = (column: unknown) => column as ReadColumn

describe("unnamedUnique", () => {
	it("names a Postgres unique as Postgres does, and an SQLite one as drizzle-kit writes it", () => {
		expect(unnamedUnique(read(pg.bare))).toBe("orders_bare_key")
		expect(unnamedUnique(read(lite.name))).toBe("orders_name_unique")
	})
})

describe("filledByDefault", () => {
	it.each(["value", "fn", "stamped", "id", "ws", "big", "small"] as const)("holds %s filled", (name) => {
		expect(filledByDefault(read(pg[name]))).toBe(true)
	})

	it("holds a bare column, and an SQLite rowid key, unfilled", () => {
		expect(filledByDefault(read(pg.bare))).toBe(false)
		expect(filledByDefault(read(lite.id))).toBe(false)
	})
})

describe("dimensionsOf", () => {
	it("reads a scalar as 0 and an array's dimensions", () => {
		expect(dimensionsOf(read(pg.bare), "orders.bare")).toBe(0)
		expect(dimensionsOf(read(pg.list), "orders.list")).toBe(1)
		expect(dimensionsOf(read(pg.grid), "orders.grid")).toBe(2)
	})

	it.each([Number.NaN, -1, 1.5])("refuses %s dimensions, naming the column", (dimensions) => {
		expect(() => dimensionsOf(read({ ...pg.list, dimensions }), "orders.list")).toThrow(
			'orders.list: drizzle could not read its array dimensions; write .array() or .array("[][]")',
		)
	})
})
