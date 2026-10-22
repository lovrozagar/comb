import { SQL } from "drizzle-orm"
import { PgDialect, integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core"
import { alias, integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { createCursor, CursorRef, openCursor } from "./cursor.ts"
import { anchored, assertNoReference, fromOf, mintWithin } from "./cursor-ref.ts"
import type { SortField } from "./types.ts"
import { SEALED } from "./__fixtures__/cursor-secret.ts"

const BY_TITLE: SortField[] = [{ direction: "asc", field: "title" }]
const doc = sqliteTable("doc", { id: integer("id").primaryKey(), title: text("title") })
const pgDoc = pgTable("doc", { id: pgInteger("id").primaryKey(), title: pgText("title") })
const sqlite = new SQLiteDialect()
const pg = new PgDialect()

describe("mintWithin", () => {
	it("mints a cursor as it is while it fits the cap", () => {
		expect(openCursor(mintWithin({ id: 1, title: "short" }, BY_TITLE, SEALED), SEALED)?.values).toEqual(["short"])
	})

	it("carries an overflowing value by the longest prefix of it that fits, within the cap", () => {
		const title = `${"長".repeat(3000)}tail`
		const cursor = mintWithin({ id: 1, title }, BY_TITLE, SEALED)
		expect(cursor.length).toBeLessThanOrEqual(8192)
		const [ref] = openCursor(cursor, SEALED)?.values ?? []
		expect(ref).toBeInstanceOf(CursorRef)
		const { prefix } = ref as CursorRef
		expect(title.startsWith(prefix)).toBe(true)
		/* one more code point of prefix would not fit */
		const longer = Array.from(title)
			.slice(0, Array.from(prefix).length + 1)
			.join("")
		expect(createCursor({ id: 1, title: new CursorRef(longer) }, BY_TITLE, SEALED).length).toBeGreaterThan(8192)
	})

	it("carries the longest values first, each by what room the others leave", () => {
		const sort: SortField[] = [
			{ direction: "asc", field: "a" },
			{ direction: "asc", field: "b" },
		]
		const cursor = mintWithin({ a: "甲".repeat(4000), b: "乙".repeat(3500), id: 1 }, sort, SEALED)
		const [a, b] = openCursor(cursor, SEALED)?.values ?? []
		expect(cursor.length).toBeLessThanOrEqual(8192)
		expect(a).toEqual(new CursorRef(""))
		expect(b).toBeInstanceOf(CursorRef)
	})

	it("refuses a derived list's overflow, and one no reference can bring under the cap, with a 500", () => {
		const derived = { ...SEALED, keyset: "derived" as const }
		expect(() => mintWithin({ id: 1, title: "長".repeat(3000) }, BY_TITLE, derived)).toThrow(
			expect.objectContaining({ cause: expect.stringContaining("a derived list reads no row"), status: 500 }),
		)
		const huge = BigInt(`1${"0".repeat(7000)}`)
		expect(() => mintWithin({ id: 1, title: huge }, BY_TITLE, SEALED)).toThrow(
			expect.objectContaining({ cause: expect.stringContaining("the other keys leave no room"), status: 500 }),
		)
	})
})

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
	it("reads a reference from the row, falling back to the prefix, or past it descending, on SQLite", () => {
		const keys = [
			{ column: doc.title, direction: "asc" as const },
			{ column: doc.title, direction: "desc" as const },
		]
		const [asc, desc, plain] = anchored(
			[...keys, keys[0]!],
			[new CursorRef("ab"), new CursorRef("ab"), "x"],
			at(doc, doc),
		)
		expect(sqlite.sqlToQuery(asc as SQL)).toEqual({
			params: [7, "ab"],
			sql: 'COALESCE((SELECT "doc"."title" FROM "doc" WHERE "doc"."id" = ?), ?)',
		})
		expect(sqlite.sqlToQuery(desc as SQL).params).toEqual([7, "ab\u{10FFFF}"])
		expect(plain).toBe("x")
	})

	it("takes the prefix on Postgres only where the column sorts by code point", () => {
		const [bound] = anchored([{ column: pgDoc.title, direction: "asc" }], [new CursorRef("ab")], at(pgDoc, pgDoc))
		expect(pg.sqlToQuery(bound as SQL).sql).toMatch(
			/^COALESCE\(\(SELECT "doc"\."title" FROM "doc" WHERE "doc"\."id" = \$1\), CASE WHEN \(pg_collation_for\("doc"\."title"\) IN \('"C"', '"POSIX"'\)/,
		)
	})

	it("refuses a reference where no row can be read, and lets every other value by", () => {
		expect(() => assertNoReference(["a", 1, null])).not.toThrow()
		expect(() => assertNoReference([new CursorRef("a")])).toThrow(
			expect.objectContaining({
				cause: expect.stringContaining("pass { keyset: 'derived' } to paginate"),
				status: 500,
			}),
		)
	})
})
