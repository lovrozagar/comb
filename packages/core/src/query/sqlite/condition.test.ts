/**
 * The one condition lowering (Q5 of r17): what each kind of column stores decides how a validated
 * value binds, on a drizzle column and on a raw one alike. Rows are tests/integration/sqlite/filter-parity.test.ts's.
 */
import { type SQL, sql } from "drizzle-orm"
import { blob, integer, numeric, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { IsoInstant } from "../iso-date.ts"
import type { FilterCondition } from "../types.ts"
import { conditionToSQL, lowerOn } from "./condition.ts"

const dialect = new SQLiteDialect()
const compile = (built: SQL | null) => (built === null ? null : dialect.sqlToQuery(built))

const t = sqliteTable("t", {
	at_ms: integer("at_ms", { mode: "timestamp_ms" }),
	at_s: integer("at_s", { mode: "timestamp" }),
	data: blob("data", { mode: "json" }),
	n: integer("n"),
	name: text("name"),
	price: numeric("price"),
})

const on = (operator: FilterCondition["operator"], value: unknown): FilterCondition => ({ field: "f", operator, value })
const JAN = new IsoInstant(Date.UTC(2024, 0, 1))

describe("conditionToSQL by the kind of drizzle column", () => {
	it("binds an instant by its milliseconds on a date or number column, by its text on a text one", () => {
		expect(compile(conditionToSQL(on("gte", JAN), t.at_ms))?.params).toEqual([JAN.ms])
		expect(compile(conditionToSQL(on("eq", JAN), t.n))?.params).toEqual([JAN.ms])
		expect(compile(conditionToSQL(on("eq", JAN), t.name))?.params).toEqual([JAN.text])
		expect(compile(conditionToSQL(on("in", [JAN]), t.at_s))?.params).toEqual([JAN.ms / 1000])
	})

	it("binds a Date by its milliseconds on a date column, as the column stores it", () => {
		expect(compile(conditionToSQL(on("lt", new Date(1500)), t.at_ms))?.params).toEqual([1500])
		expect(compile(conditionToSQL(on("lt", new Date(1500)), t.at_s))?.params).toEqual([2])
	})

	it("refuses a number on a text column and text on a date or number one; numeric takes both", () => {
		expect(conditionToSQL(on("eq", 5), t.name)).toBeNull()
		expect(conditionToSQL(on("eq", "x"), t.n)).toBeNull()
		expect(conditionToSQL(on("in", ["x"]), t.at_ms)).toBeNull()
		expect(conditionToSQL(on("like", "x*"), t.n)).not.toBeNull()
		expect(compile(conditionToSQL(on("eq", "10"), t.price))?.params).toEqual(["10"])
		expect(compile(conditionToSQL(on("contains", "x"), t.n))?.sql).toContain("json_each")
	})

	it("binds a value as validated on a column of no kind it knows, through the column's mapper", () => {
		expect(compile(conditionToSQL(on("is", "notnull"), t.data))?.sql).toBe('("t"."data" is not null)')
		expect(conditionToSQL(on("is", "maybe"), t.data)).toBeNull()
		expect(conditionToSQL(on("between" as FilterCondition["operator"], 1), t.data)).toBeNull()
	})
})

describe("lowerOn a raw column", () => {
	const raw = sql`"r"."at"`

	it("rounds epoch milliseconds to the second that keeps a seconds column exact", () => {
		expect(compile(lowerOn({ kind: "date-s", sql: raw }, on("gt", 1500)))).toEqual({ params: [1], sql: '"r"."at" > ?' })
		expect(compile(lowerOn({ kind: "date-s", sql: raw }, on("lte", 1500)))?.params).toEqual([1])
		expect(compile(lowerOn({ kind: "date-s", sql: raw }, on("lt", 1500)))?.params).toEqual([2])
		expect(compile(lowerOn({ kind: "date-s", sql: raw }, on("eq", 1500)))?.sql).toBe("0")
		expect(compile(lowerOn({ kind: "date-s", sql: raw }, on("ne", 2000)))?.sql).toBe('"r"."at" <> ?')
		expect(compile(lowerOn({ kind: "date-s", sql: raw }, on("neq", 1500)))?.sql).toBe('("r"."at" is not null)')
		expect(compile(lowerOn({ kind: "date-s", sql: raw }, on("nin", [2000])))?.params).toEqual([2])
		expect(compile(lowerOn({ kind: "date-s", sql: raw }, on("is", null)))?.sql).toBe('("r"."at" is null)')
	})

	it("binds an instant as its text on a column of no kind", () => {
		expect(compile(lowerOn({ kind: "as-is", sql: raw }, on("eq", JAN)))?.params).toEqual([JAN.text])
	})
})
