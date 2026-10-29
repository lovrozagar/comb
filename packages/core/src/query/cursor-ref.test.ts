import { PgDialect, integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core"
import { alias, integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { CursorRef } from "./cursor.ts"
import { anchored, assertNoReference, fromOf } from "./cursor-ref.ts"
import { AnchorBound } from "./sqlite/keyset.ts"

const doc = sqliteTable("doc", { id: integer("id").primaryKey(), title: text("title") })
const pgDoc = pgTable("doc", { id: pgInteger("id").primaryKey(), title: pgText("title") })
const sqlite = new SQLiteDialect()
const pg = new PgDialect()

describe("fromOf", () => {
	it("names a table as itself, and an aliased one by its name with the alias reapplied", () => {
		expect(sqlite.sqlToQuery(fromOf(doc)).sql).toBe('"doc"')
		expect(sqlite.sqlToQuery(fromOf(alias(doc, "d0"))).sql).toBe('"doc" AS "d0"')
		const scoped = Object.assign(Object.create(pgDoc), { [Symbol.for("drizzle:Schema")]: "app" })
		expect(pg.sqlToQuery(fromOf(scoped)).sql).toBe('"app"."doc"')
	})
})

/** Where a reference is read: row 7 of `table`, keyed by its id column */
const at = (table: object, column: { id: unknown }) => ({ id: 7, table, tiebreak: column.id as never })

describe("anchored and assertNoReference", () => {
	it("reads a reference from the row while it keeps the prefix and length, else the prefix, or past it descending, on SQLite", () => {
		const keys = [
			{ column: doc.title, direction: "asc" as const },
			{ column: doc.title, direction: "desc" as const },
		]
		const [asc, desc, empty, plain] = anchored(
			[...keys, keys[0]!, keys[0]!],
			[new CursorRef("a𝟘", 9), new CursorRef("ab", 9), new CursorRef("", 9), "x"],
			at(doc, doc),
		)
		expect(asc).toBeInstanceOf(AnchorBound)
		expect(sqlite.sqlToQuery((asc as AnchorBound).value)).toEqual({
			params: ["a𝟘", 7],
			sql: '(SELECT CASE WHEN substr("doc"."title", 1, 2) = comb_anchor.v AND length("doc"."title") = 9 THEN "doc"."title" ELSE comb_anchor.v END FROM (SELECT ? AS v) AS comb_anchor LEFT JOIN "doc" ON "doc"."id" = ?)',
		})
		expect(sqlite.sqlToQuery((desc as AnchorBound).value).sql).toContain("ELSE (comb_anchor.v || char(1114111)) END")
		expect(sqlite.sqlToQuery((empty as AnchorBound).value)).toMatchObject({ params: [7] })
		expect((asc as AnchorBound).ends).toBe(false)
		expect(plain).toBe("x")
	})

	it("takes the prefix on Postgres only where the column sorts by code point, and ends the list where it does not", () => {
		const [bound] = anchored([{ column: pgDoc.title, direction: "asc" }], [new CursorRef("ab", 5)], at(pgDoc, pgDoc))
		expect((bound as AnchorBound).ends).toBe(true)
		expect(pg.sqlToQuery((bound as AnchorBound).value).sql).toMatch(
			/^\(SELECT CASE WHEN left\("doc"\."title", 2\) = comb_anchor\.v AND char_length\("doc"\."title"\) = 5 THEN "doc"\."title" ELSE CASE WHEN \(pg_collation_for/,
		)
	})

	it("refuses a reference where no row can be read, and lets every other value by", () => {
		expect(() => assertNoReference(["a", 1, null])).not.toThrow()
		expect(() => assertNoReference([new CursorRef("a", 1)])).toThrow(
			expect.objectContaining({
				cause: expect.stringContaining("give buildDerivedListQuery the table its rows are as anchor"),
				status: 500,
			}),
		)
	})
})

/* U10 of the 0.12 round: a seconds-mode key's fallback, before 1970 too, rounded toward the rows already served */
describe("anchored on a seconds-mode timestamp key", () => {
	const event = sqliteTable("event", { at: integer("at", { mode: "timestamp" }), id: integer("id").primaryKey() })
	it("falls back to the milliseconds ascending, and one past them descending, signed", () => {
		const [asc, desc] = anchored(
			[
				{ column: event.at, direction: "asc" },
				{ column: event.at, direction: "desc" },
			],
			[new Date(-1500), new Date(-1500)],
			at(event, event),
		)
		expect(sqlite.sqlToQuery((asc as AnchorBound).value).sql).toContain("(-1501 / 1000.0)")
		expect(sqlite.sqlToQuery((desc as AnchorBound).value).sql).toContain("(-1500 / 1000.0)")
	})
})

/* U14 of the 0.12 round: a value readCursor returns by reference is one a consumer can test for */
describe("the query entry point", () => {
	it("exports the CursorRef readCursor may return", async () => {
		const query = await import("./index.ts")
		expect(query.CursorRef).toBe(CursorRef)
	})
})
