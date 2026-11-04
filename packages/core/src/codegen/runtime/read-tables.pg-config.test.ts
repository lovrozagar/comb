/**
 * F45 of the 0.13.0 round: drizzle's pg-core hands a table's third argument ExtraConfigColumn
 * stand-ins, not the table's own columns, where sqlite-core passes the columns themselves. Every
 * constraint the third argument names by column is read by the column's SQL name on both.
 */
import { foreignKey, index, integer, pgTable, primaryKey, text, unique, uniqueIndex } from "drizzle-orm/pg-core"
import { index as sqliteIndex, integer as sqliteInteger, sqliteTable } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { FIXTURE_TABLES } from "../__fixtures__/runtime.ts"
import { snapshotOf } from "./read-tables.ts"

const parent = pgTable("parent", { id: integer("id").primaryKey() })
const child = pgTable("child", { a: integer("a").notNull(), b: integer("bee").notNull(), p: integer("p") }, (t) => [
	index("child_ab").on(t.a, t.b),
	uniqueIndex("child_p_u").on(t.p),
	unique("child_ab_unique").on(t.a, t.b),
	primaryKey({ columns: [t.a, t.b] }),
	foreignKey({ columns: [t.p], foreignColumns: [parent.id] }),
])

/* these tables hold no array column, so the reader asks no element type */
const noArrays = (): boolean => {
	throw new Error("asked for an array column's element")
}

/** The snapshot of `namespace`'s tables, as the runtime reader reads a tables module exporting them */
const tablesOf = (namespace: Record<string, unknown>) =>
	snapshotOf([{ external: false, module: FIXTURE_TABLES, namespace }], noArrays).tables

/** The child table as the reader reads it */
const read = () => tablesOf({ child, parent }).find((table) => table.exportName === "child")

describe("a Postgres table's third argument, read by column (F45)", () => {
	it("reads an index and a unique index on its columns, by key", () => {
		expect(read()?.indexes.map((each) => ({ columns: each.columns, name: each.name, unique: each.unique }))).toEqual([
			{ columns: ["a", "b"], name: "child_ab", unique: false },
			{ columns: ["p"], name: "child_p_u", unique: true },
		])
		expect(read()?.indexes[0]?.expression).toBe('"a", "bee"')
	})

	it("reads unique().on() and a composite primary key by key", () => {
		expect(read()?.uniques).toEqual([{ columns: ["a", "b"], name: "child_ab_unique" }])
		expect(read()?.compositeKey).toEqual(["a", "b"])
	})

	it("records a foreignKey() on its column, toward the target's key", () => {
		expect(read()?.columns.find((column) => column.key === "p")?.foreignKey).toMatchObject({
			column: "id",
			table: "parent",
		})
	})

	it("records a composite foreignKey() on each of its columns, the key whole beside it (F46)", () => {
		const pair = pgTable("pair", { a: integer("a"), b: integer("bee") }, (t) => [
			foreignKey({ columns: [t.a, t.b], foreignColumns: [child.a, child.b] }),
		])
		const readPair = tablesOf({ child, pair, parent }).find((table) => table.exportName === "pair")
		const key = { columns: ["a", "b"], refColumns: ["a", "b"] }
		expect(readPair?.columns.map((column) => column.foreignKey)).toEqual([
			expect.objectContaining({ column: "a", key, table: "child" }),
			expect.objectContaining({ column: "b", key, table: "child" }),
		])
	})

	it("refuses, naming the table, a part that is neither its column nor SQL", () => {
		const stray = pgTable("stray", { a: integer("a") }, () => [index("stray_x").on(parent.id)])
		expect(() => tablesOf({ parent, stray })).toThrow("stray")
	})
})

describe("a SQLite table's third argument naming another table's column", () => {
	it("is refused, naming the table, as on Postgres", () => {
		const owner = sqliteTable("owner", { id: sqliteInteger("id").primaryKey() })
		const stray = sqliteTable("stray", { a: sqliteInteger("a") }, () => [sqliteIndex("stray_x").on(owner.id)])
		expect(() => tablesOf({ owner, stray })).toThrow(
			"stray: its third argument names the column id, which is no column of stray",
		)
	})
})

describe("an array column's element, as its drizzle type declares it (A2-9 of r22)", () => {
	it("asks the type of each array column alone, by its table's export, key and dimensions, and records it", () => {
		const row = pgTable("row", {
			grid: integer("grid").array("[][]"),
			id: text("id").primaryKey(),
			tags: text("tags").array(),
		})
		const asked: string[] = []
		const elementNulls = (table: string, key: string, dimensions: number): boolean => {
			asked.push(`${table}.${key}:${dimensions}`)
			return key === "grid"
		}
		const [table] = snapshotOf([{ external: false, module: FIXTURE_TABLES, namespace: { row } }], elementNulls).tables
		expect(asked.toSorted()).toEqual(["row.grid:2", "row.tags:1"])
		expect(Object.fromEntries((table?.columns ?? []).map((column) => [column.key, column.nullElements]))).toEqual({
			grid: true,
			id: false,
			tags: false,
		})
	})
})
