/**
 * The extras a SQLite or Postgres list selects to carry its keys' stored texts: _combKeyTexts, the
 * text a read would round, and _combTextKeys, a SQLite key's stored value its mode reads as another.
 */
import { sql } from "drizzle-orm"
import {
	customType,
	date,
	numeric as pgNumeric,
	PgDialect,
	pgTable,
	text as pgText,
	time,
	timestamp,
} from "drizzle-orm/pg-core"
import { integer, numeric, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { keyTextsSQL, textKeysSQL } from "./key-texts.ts"

/** keyTextsSQL of `column` alone on SQLite, bound as read, rendered */
const render = (column: Parameters<typeof keyTextsSQL>[0][number]["column"]) =>
	new SQLiteDialect().sqlToQuery(keyTextsSQL([{ column, direction: "asc" }], "sqlite", () => true)).sql

/** The types a Postgres key's guard may name: numeric and the times it carries the text of, and a float it marks where the session prints it rounded (AB4-4 of area B) */
const TYPES_ALLOWED = [
	"numeric",
	"timestamp without time zone",
	"timestamp with time zone",
	"date",
	"double precision",
	"real",
]

/*
 * AB1 of area B: keyTextsSQL joins the carried texts on a comma, so a carried text must never hold
 * one. Only a numeric's text (digits, a sign, a point, NaN, Infinity), a time's (ISO under every
 * DateStyle) and SQLite's REAL seconds are carried; any other key is read exactly and carries ''.
 */
describe("keyTextsSQL carries only numeric, time and seconds texts (AB1 of area B; sibling: QL3's carriage)", () => {
	const kinds = pgTable("kinds", {
		amount: customType<{ data: number; driverData: string }>({ dataType: () => "amount" })("amount"),
		at: timestamp("at", { mode: "string", precision: 6 }),
		id: pgText("id").primaryKey(),
		label: pgText("label"),
		n: pgNumeric("n", { mode: "number" }),
		when: timestamp("when", { precision: 6 }),
	})
	const sqliteKinds = sqliteTable("sqlite_kinds", {
		at: integer("at", { mode: "timestamp" }),
		label: integer("label"),
	})
	const pgKeys: Array<[string, Parameters<typeof keyTextsSQL>[0][number]["column"], boolean]> = [
		["a numeric in number mode", kinds.n, true],
		["a date-mode timestamp", kinds.when, true],
		["a string-mode timestamp", kinds.at, true],
		["a text column", kinds.label, false],
		["an expression", sql`${kinds.label}`, true],
		["a customType column", kinds.amount, true],
	]
	it.each([false, true])(
		"names no type but a numeric, a time or a float in a Postgres key's guard (as read: %s)",
		(asRead) => {
			const rendered = new PgDialect().sqlToQuery(
				keyTextsSQL(
					pgKeys.map(([, column]) => ({ column, direction: "asc" as const })),
					"postgres",
					() => asRead,
				),
			).sql
			const named = [...rendered.matchAll(/'([^']+)'::regtype/g)].map((match) => match[1])
			expect(named.length).toBeGreaterThan(0)
			expect(named.filter((type) => !TYPES_ALLOWED.includes(type as string))).toEqual([])
		},
	)

	it.each(pgKeys)("carries %s's text or nothing, by its type", (_, column, carries) => {
		const rendered = new PgDialect().sqlToQuery(keyTextsSQL([{ column, direction: "asc" }], "postgres", () => true)).sql
		expect(rendered === "''").toBe(!carries)
	})

	/* AB2 of area B: its mapper may read a numeric as a number; a time binds through that mapper, so it carries none */
	it("carries a Postgres customType column's text where it is a numeric alone, bound as read or not", () => {
		for (const asRead of [false, true]) {
			const rendered = new PgDialect().sqlToQuery(
				keyTextsSQL([{ column: kinds.amount, direction: "asc" }], "postgres", () => asRead),
			).sql
			expect(rendered).toMatch(/^coalesce\(case when \(pg_typeof\("kinds"\."amount"\) = 'numeric'::regtype or /)
			expect(rendered).not.toContain("timestamp")
		}
	})

	it("carries SQLite's REAL seconds of a seconds-mode timestamp alone, as a number's digits", () => {
		expect(render(sqliteKinds.at)).toContain("printf('%!.17g', ")
		expect(render(sqliteKinds.label)).not.toContain("printf")
		expect(render(sql`${sqliteKinds.label}`)).toBe("''")
	})
})

/* AB4-2 of area B: a mark is `!` and a storage class's name, which holds no comma */
describe("keyTextsSQL's mark of a SQLite stored class (AB4-2 of area B; sibling: AB1's carriage)", () => {
	const marks = sqliteTable("sqlite_marks", {
		at: integer("at", { mode: "timestamp" }),
		data: text("data", { mode: "json" }),
		flag: integer("flag", { mode: "boolean" }),
		num: numeric("num"),
		tag: text("tag"),
	})
	it("marks a SQLite key of a class its mode reads as another `!` and the class, and an expression nothing", () => {
		expect(render(marks.tag)).toBe(
			`case when (typeof("sqlite_marks"."tag") in ('null', 'text')) then '' else '!' || typeof("sqlite_marks"."tag") end`,
		)
		expect(render(marks.at)).toContain(`when (typeof("sqlite_marks"."at") in ('null', 'integer', 'real')) then ''`)
		expect(render(marks.flag)).toContain(
			`when ("sqlite_marks"."flag" is null or (typeof("sqlite_marks"."flag") in ('integer', 'real') and "sqlite_marks"."flag" in (0, 1))) then ''`,
		)
		expect(render(marks.data)).toBe("''")
	})

	it("marks a numeric()'s ±Infinity, a REAL short of 9e999 alone held", () => {
		expect(render(marks.num)).toBe(
			`case when (typeof("sqlite_marks"."num") in ('null', 'integer') or (typeof("sqlite_marks"."num") = 'real' and abs("sqlite_marks"."num") < 9e999)) then '' else '!' || typeof("sqlite_marks"."num") end`,
		)
	})
})

/** keyTextsSQL of `column` alone on Postgres, bound as read or not, rendered */
const carried = (column: Parameters<typeof keyTextsSQL>[0][number]["column"], asRead: boolean) =>
	new PgDialect().sqlToQuery(keyTextsSQL([{ column, direction: "asc" }], "postgres", () => asRead)).sql

/*
 * AB3-4 of area B: a Postgres time key's read follows DateStyle, a string-mode one's text included
 * (`01/01/2024 05:30:00 IST`, whose zone reads back as another), so every list carries to_json's text,
 * one that reads the key back from its anchor row too: with the row gone, the cursor binds it
 */
describe("keyTextsSQL carries a Postgres time key's to_json text on every list (AB3-4 of area B; sibling: B2-7)", () => {
	const times = pgTable("times", {
		at: timestamp("at", { mode: "string", precision: 6, withTimezone: true }),
		clock: time("clock"),
		day: date("day"),
		label: pgText("label"),
		when: timestamp("when", { precision: 6 }),
	})

	it.each([false, true])("carries a timestamp, a date and a time expression in either mode (as read: %s)", (asRead) => {
		for (const column of [times.at, times.day, times.when, sql`${times.at}`])
			expect(carried(column, asRead)).toContain("to_json(")
	})

	it("carries no text for a key DateStyle does not write: a time of day or a text", () => {
		expect(carried(times.clock, false)).toBe("''")
		expect(carried(times.label, false)).toBe("''")
	})
})

/** textKeysSQL of `keys` on SQLite, rendered */
const rendered = (keys: Parameters<typeof textKeysSQL>[0], held?: Parameters<typeof textKeysSQL>[1]) =>
	new SQLiteDialect().sqlToQuery(textKeysSQL(keys, held)).sql

/* B2-3 of area B: a SQLite timestamp key may hold TEXT, which drizzle reads as an invalid Date */
describe("textKeysSQL selects each key's stored value its mode reads as another (B2-3, AB4-2 of area B; sibling: keyTextsSQL)", () => {
	const post = sqliteTable("post", {
		j: text("j", { mode: "json" }),
		m: integer("m", { mode: "timestamp_ms" }),
		n: integer("n"),
		s: integer("s", { mode: "timestamp" }),
	})
	it("takes a JSON array of each key's class and text where its mode reads another, a null for a key with no set", () => {
		const texts = rendered([
			{ column: post.s, direction: "asc" },
			{ column: post.j, direction: "desc" },
			{ column: post.n, direction: "asc" },
		])
		expect(texts).toMatch(
			/^json_array\(case when \(typeof\("post"."s"\) in \('null', 'integer', 'real'\)\) then null .*, null, case when \(typeof\("post"."n"\) in \('null', 'integer', 'real'\)\) then null /,
		)
		expect(texts).toContain(
			`when typeof("post"."n") = 'text' then json_array('text', "post"."n") else json_array('blob', hex("post"."n")) end)`,
		)
	})

	it("takes an empty text where no key is held apart: none with a set, or every one bound as read", () => {
		expect(rendered([{ column: post.j, direction: "asc" }])).toBe("''")
		expect(rendered([])).toBe("''")
		expect(rendered([{ column: post.s, direction: "asc" }], () => false)).toBe("''")
	})
})
