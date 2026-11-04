import { getTableColumns, type SQL, SQL as SQLClass, sql } from "drizzle-orm"
import {
	customType as pgCustomType,
	numeric as pgNumeric,
	PgDialect,
	pgTable,
	timestamp,
	vector,
} from "drizzle-orm/pg-core"
import {
	alias,
	blob,
	customType,
	integer,
	numeric,
	real,
	SQLiteDialect,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import {
	assertCursorFits,
	bindable,
	boundAsRead,
	boundCarried,
	boundForKeys,
	carriesOpaque,
	DateKey,
	readsBack,
	readsRounded,
	refersBack,
} from "./cursor-fit.ts"

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
		["count", "one"],
		["active", 0],
		["seen_at", 1],
		["seen_at", "2024"],
		["meta", { a: 1 }],
		["big", "1"],
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
		for (const value of ["2024-01-01", "07", Number.NaN, Number.POSITIVE_INFINITY])
			expect(() => assertCursorFits([at], [value])).toThrow()
		expect(boundForKeys("sqlite", [at, sql`x`], [new Date(5), new Date(6)])).toEqual([5, new Date(6)])
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
		expect(boundForKeys("sqlite", [sql`x`, sql`y`], [7n, 9007199254740993n])).toEqual([7, 9007199254740993n])
	})

	it("checks every position, the tiebreak id last", () => {
		expect(() => assertCursorFits([columns.name, columns.count], ["a", "x"])).toThrow()
	})
})

/* 27.7 of plan 15: the one rule a reference is minted and read by */
describe("readsBack", () => {
	const doc = sqliteTable("doc", { id: integer("id"), notes: text("notes"), rank: integer("rank") })
	const other = sqliteTable("other", { label: text("label") })

	it("takes the anchor table's column of any type, and an expression over its own columns alone, through any nesting (QL1 of r22b)", () => {
		expect(readsBack(doc.notes, undefined)).toBe(true)
		expect(readsBack(doc.rank, doc)).toBe(true)
		expect(readsBack(sql`lower(${doc.notes})`, doc)).toBe(true)
		expect(readsBack(sql`coalesce(${sql`lower(${doc.notes})`}, ${doc.id})`, doc)).toBe(true)
		expect(readsBack(sql.join([doc.notes, doc.rank], sql`, `), doc)).toBe(true)
		/* a list drizzle keeps as one chunk, as `IN (${[...]})` writes it */
		expect(readsBack(sql`${doc.id} IN (${[doc.notes, doc.rank]})`, doc)).toBe(true)
	})

	it("refuses an expression with no anchor, none over a column, or a key over another table", () => {
		/* a joined table's column reads the anchor's own value back (27.14), whatever it holds (QL1 of r22b) */
		expect(readsBack(other.label, doc)).toBe(false)
		expect(readsBack(other.label, undefined)).toBe(true)
		/* 27.19: an alias is the table it names; another alias of the same table, or no drizzle table, is not */
		const mine = alias(doc, "mine")
		expect(readsBack(mine.notes, mine)).toBe(true)
		expect(readsBack(alias(doc, "theirs").notes, mine)).toBe(false)
		expect(readsBack(doc.notes, mine)).toBe(false)
		expect(readsBack(doc.notes, {})).toBe(false)
		expect(readsBack(sql`lower(${doc.notes})`, undefined)).toBe(false)
		expect(readsBack(sql.raw('lower("doc"."notes")'), doc)).toBe(false)
		expect(readsBack(sql`${doc.notes} || ${other.label}`, doc)).toBe(false)
		expect(readsBack(new DateKey(sql`${doc.rank}`), doc)).toBe(false)
	})
})

describe("refersBack", () => {
	const doc = sqliteTable("doc", { notes: text("notes"), rank: integer("rank") })
	const other = sqliteTable("other", { label: text("label") })

	it("takes a key the row supplies whose column, if it is one, holds text", () => {
		expect(refersBack(doc.notes, doc)).toBe(true)
		expect(refersBack(doc.notes, undefined)).toBe(true)
		expect(refersBack(sql`lower(${doc.notes})`, doc)).toBe(true)
		expect(refersBack(doc.rank, doc)).toBe(false)
		expect(refersBack(other.label, doc)).toBe(false)
	})
})

/** Whether a cursor carrying `value` fits `column`, bound as read or not */
const carried = (column: Parameters<typeof assertCursorFits>[0][number], value: unknown, asRead: boolean) => {
	try {
		assertCursorFits([column], [value], { asRead: () => asRead })
		return true
	} catch {
		return false
	}
}

/** The parameters a bound value renders to */
const shown = (value: unknown) => new SQLiteDialect().sqlToQuery(value as SQL).params

/* QL2 of r22b: a key bound as read carries a time key's stored value, where a Date can't hold it */
describe("a time key's stored value on a key bound as read (QL2 of r22b; sibling: a Date)", () => {
	const pgEvent = pgTable("ev", { at: timestamp("at", { precision: 6 }) })

	it("takes a Postgres date column's text and a SQLite seconds column's number only where the key binds as read", () => {
		expect(carried(pgEvent.at, "2024-01-01 00:00:00.1231", true)).toBe(true)
		expect(carried(pgEvent.at, "2024-01-01 00:00:00.1231", false)).toBe(false)
		expect(carried(pgEvent.at, 1, true)).toBe(false)
		expect(carried(columns.seen_at, 100.0001, true)).toBe(true)
		expect(carried(columns.seen_at, 100.0001, false)).toBe(false)
		expect(carried(columns.seen_at, "100", true)).toBe(false)
		expect(carried(columns.count, "x", true)).toBe(false)
		expect(carried(columns.seen_at, new Date(1), true)).toBe(true)
	})

	it("binds the carried value as itself, past the column's Date mapper, and a Date as before", () => {
		expect(shown(boundAsRead(pgEvent.at, "2024-01-01 00:00:00.1231"))).toEqual(["2024-01-01 00:00:00.1231"])
		expect(shown(boundAsRead(columns.seen_at, 100.0001))).toEqual([100.0001])
		expect(shown(boundAsRead(columns.seen_at, new Date(100_001)))).toEqual([100.001])
		const date = new Date(1)
		expect(boundAsRead(pgEvent.at, date)).toBe(date)
		expect(boundAsRead(columns.count, 5)).toBe(5)
		expect(boundAsRead(sql`x`, "a")).toBe("a")
		expect(boundAsRead(pgEvent.at, null)).toBeNull()
		expect(boundAsRead(columns.seen_at, sql`9e999`)).toBeInstanceOf(SQLClass)
	})
})

/* Q2 of r19: libsql's intMode "string" reads an INTEGER as its canonical decimal string */
describe("assertCursorFits on what libsql's intMode string reads", () => {
	it("takes a canonical integer string on a number column, and binds it as that integer, exact", () => {
		for (const value of ["1", "-5", "9007199254740993"]) expect(fits("count", value), value).toBe(true)
		for (const value of ["01", "1.5", "", "+1"]) expect(fits("count", value), value).toBe(false)
		expect(boundForKeys("sqlite", [columns.count, sql`x`], ["7", "7"])).toEqual([7, "7"])
		expect(boundForKeys("sqlite", [columns.count], ["9007199254740993"])).toEqual([9007199254740993n])
	})

	it("takes a time key's epoch milliseconds as a decimal string, and binds them as that number", () => {
		const at = new DateKey(sql`max(created_at)`)
		expect(() => assertCursorFits([at], ["1700000000000"])).not.toThrow()
		expect(boundForKeys("sqlite", [at], ["1700000000000"])).toEqual([1700000000000])
	})
})

/* QL3 of r22b: a Postgres numeric in number mode reads rounded, so its list carries its text and a cursor binds that */
describe("a key that reads its number rounded (QL3 of r22b; sibling: a time key's stored value)", () => {
	const amounts = pgTable("amounts", {
		exact: pgNumeric("exact"),
		n: pgNumeric("n", { mode: "number" }),
	})
	const local = sqliteTable("local", { n: numeric("n", { mode: "number" }) })

	it("is a Postgres numeric in number mode, never one read as a string, a SQLite numeric or an expression", () => {
		expect(readsRounded(amounts.n)).toBe(true)
		expect(readsRounded(amounts.exact)).toBe(false)
		expect(readsRounded(local.n)).toBe(false)
		expect(readsRounded(sql`${amounts.n}`)).toBe(false)
		expect(readsRounded(undefined)).toBe(false)
	})

	it("takes the text Postgres prints a numeric as, whether or not the key binds as read, and no other text", () => {
		for (const value of ["0.1000000000000000001", "-12", "NaN", "Infinity", "-Infinity", 0.1, null])
			expect(carried(amounts.n, value, false), String(value)).toBe(true)
		for (const value of ["1e5", "0.", ".5", "abc", ""]) expect(carried(amounts.n, value, true), value).toBe(false)
	})

	it("binds the carried text cast to numeric, and any other value as before", () => {
		const bound = boundCarried(amounts.n, "0.1000000000000000001", true) as SQL
		expect(new PgDialect().sqlToQuery(bound)).toEqual({ params: ["0.1000000000000000001"], sql: "$1::numeric" })
		expect(boundCarried(amounts.n, 0.1, false)).toBe(0.1)
		expect(boundCarried(amounts.exact, "0.1", true)).toBe("0.1")
	})
})

/* QL4 of r22b: a Postgres list binds a cursor value as its driver does, never as the SQLite literal 9e999 */
describe("boundForKeys by the list's dialect (QL4 of r22b; sibling: SQLite's binding above)", () => {
	it("binds ±Infinity, a bigint and an integer text as they are on Postgres, and a time key's Date as its milliseconds", () => {
		const values = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 7n, "9007199254740993", new Date(5)]
		const keys = [sql`a`, sql`b`, sql`c`, columns.count, new DateKey(sql`d`)]
		expect(boundForKeys("postgres", keys, values)).toEqual([...values.slice(0, 4), 5])
		expect(boundForKeys("sqlite", keys, values)).toEqual([sql`9e999`, sql`-9e999`, 7, 9007199254740993n, 5])
	})
})

/* QL5 of r22b: a blob key's cursor carries its bytes, which it fits and binds */
describe("a blob key's cursor value (QL5 of r22b; sibling: a json key, which no cursor carries)", () => {
	const files = sqliteTable("files", { b: blob("b", { mode: "buffer" }), j: text("j", { mode: "json" }) })

	it("fits bytes on a buffer-mode blob, and nothing on a json column", () => {
		expect(() => assertCursorFits([files.b], [new Uint8Array([1])])).not.toThrow()
		expect(() => assertCursorFits([files.b], ["01"])).toThrow()
		expect(() => assertCursorFits([files.j], [new Uint8Array([1])])).toThrow()
		expect(boundForKeys("sqlite", [files.b], [new Uint8Array([1])])).toEqual([new Uint8Array([1])])
	})
})

/* AB2 of area B: a customType key fits what its mapper read, and a Postgres one carries a numeric's text */
describe("a customType key's cursor value (AB2 of area B; sibling: QL5's blob)", () => {
	const amount = pgCustomType<{ data: number; driverData: string }>({ dataType: () => "amount" })
	const pgItems = pgTable("pg_items", { a: amount("a"), n: pgNumeric("n", { mode: "number" }) })

	it("takes on a customType column any value a cursor carries, as its fromDriver read it", () => {
		for (const value of ["x", 1, 1n, false, new Date(1), new Uint8Array([1])]) expect(fits("blobby", value)).toBe(true)
		expect(fits("blobby", { a: 1 })).toBe(false)
	})

	it("refuses every value on a family no cursor carries, and on a dataType drizzle names no family of", () => {
		/* drizzle gives an .array() its element's dataType; a vector is the array family */
		const tags = pgTable("tags", { v: vector("v", { dimensions: 1 }) })
		expect(tags.v.dataType).toBe("array vector")
		expect(() => assertCursorFits([tags.v], [1])).toThrow()
		const unknown = Object.assign(Object.create(columns.name) as object, { dataType: "vector" })
		expect(() => assertCursorFits([unknown as typeof columns.name], ["a"])).toThrow()
	})

	it("carries its text only on a Postgres custom column", () => {
		expect(carriesOpaque(pgItems.a)).toBe(true)
		expect(carriesOpaque(columns.blobby)).toBe(false)
		expect(carriesOpaque(pgItems.n)).toBe(false)
		expect(carriesOpaque(sql`${pgItems.a}`)).toBe(false)
		expect(carriesOpaque(undefined)).toBe(false)
	})

	it("binds a numeric's text past the mapper on a Postgres custom column, and any other value as before", () => {
		const bound = boundCarried(pgItems.a, "0.1000000000000000001", true) as SQL
		expect(new PgDialect().sqlToQuery(bound)).toEqual({ params: ["0.1000000000000000001"], sql: "$1" })
		expect(boundCarried(pgItems.a, "a,b", true)).toBe("a,b")
		expect(boundCarried(pgItems.a, 0.1, true)).toBe(0.1)
		expect(boundCarried(columns.blobby, "1", true)).toBe("1")
	})

	/* comb-9d's AB2 ruling: a value as read, one that looks like a number too, binds through the column's toDriver */
	it("binds a value as read, a numeric-looking text included, through the mapper on every column", () => {
		expect(boundCarried(pgItems.a, "12", false)).toBe("12")
		expect(boundCarried(pgItems.n, "0.1000000000000000001", false)).toBe("0.1000000000000000001")
	})
})
