import { sql } from "drizzle-orm"
import { alias, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { DateKey } from "./cursor-fit.ts"
import { readsBack, refersBack } from "./reads-back.ts"

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
