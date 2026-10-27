import { integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { CursorRef } from "../cursor.ts"
import { createCursor } from "../cursor-mint.ts"
import type { SortField } from "../types.ts"
import { SEALED } from "../__fixtures__/cursor-secret.ts"
import { cursorWhere } from "./cursor-where.ts"

const doc = sqliteTable("doc", { id: integer("id").primaryKey(), title: text("title") })
const sort: SortField[] = [{ direction: "asc", field: "title" }]
const keys = [{ column: doc.title, direction: "asc" as const }]
const tiebreak = { column: doc.id, direction: "asc" as const }
const dialect = new SQLiteDialect()

describe("cursorWhere", () => {
	it("resumes after the cursor's row, a reference read from the table", () => {
		const plain = cursorWhere({
			cursor: createCursor({ id: 3, title: "b" }, sort, SEALED),
			keys,
			options: SEALED,
			sort,
			table: doc,
			tiebreak,
		})
		expect(dialect.sqlToQuery(plain).params).toEqual(["b", "b", 3])
		const byRef = createCursor({ id: 3, title: new CursorRef("b", 1) }, sort, SEALED)
		const read = cursorWhere({ cursor: byRef, keys, options: SEALED, sort, table: doc, tiebreak })
		expect(dialect.sqlToQuery(read).sql).toContain('LEFT JOIN "doc" ON "doc"."id" = ?)')
	})

	it("refuses a reference on a list with no table, and a value its key cannot take", () => {
		const byRef = createCursor({ id: 3, title: new CursorRef("b", 1) }, sort, SEALED)
		expect(() => cursorWhere({ cursor: byRef, keys, options: SEALED, sort, table: undefined, tiebreak })).toThrow(
			expect.objectContaining({ status: 500 }),
		)
		const wrong = createCursor({ id: 3, title: 5 }, sort, SEALED)
		expect(() => cursorWhere({ cursor: wrong, keys, options: SEALED, sort, table: doc, tiebreak })).toThrow(
			expect.objectContaining({ errorKey: "invalid_cursor", status: 400 }),
		)
	})
})

/* U10 of the 0.12 round: a seconds-mode key with no table to read its row from binds its Date to the millisecond */
describe("cursorWhere on a seconds-mode timestamp key", () => {
	const event = sqliteTable("event", { at: integer("at", { mode: "timestamp" }), id: integer("id").primaryKey() })
	const bySort: SortField[] = [{ direction: "asc", field: "at" }]
	const atKeys = [{ column: event.at, direction: "asc" as const }]
	const cursor = createCursor({ at: new Date(1_700_000_000_123), id: 3 }, bySort, SEALED)

	it("binds the exact milliseconds on a list with no table", () => {
		const where = cursorWhere({
			cursor,
			keys: atKeys,
			options: SEALED,
			sort: bySort,
			table: undefined,
			tiebreak: { column: event.id, direction: "asc" },
		})
		expect(dialect.sqlToQuery(where).params).toContain(1_700_000_000.123)
	})

	it("reads the bound from the row on a list with a table, the milliseconds its fallback", () => {
		const where = cursorWhere({
			cursor,
			keys: atKeys,
			options: SEALED,
			sort: bySort,
			table: event,
			tiebreak: { column: event.id, direction: "asc" },
		})
		expect(dialect.sqlToQuery(where).sql).toContain(
			'coalesce((SELECT CASE WHEN CAST("event"."at" * 1000 AS INTEGER) = 1700000000123 THEN "event"."at" END FROM "event" WHERE "event"."id" = ?), (1700000000123 / 1000.0))',
		)
	})
})
