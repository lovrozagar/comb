import { integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { CursorRef, createCursor } from "../cursor.ts"
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
		const byRef = createCursor({ id: 3, title: new CursorRef("b") }, sort, SEALED)
		const read = cursorWhere({ cursor: byRef, keys, options: SEALED, sort, table: doc, tiebreak })
		expect(dialect.sqlToQuery(read).sql).toContain('(SELECT "doc"."title" FROM "doc" WHERE "doc"."id" = ?)')
	})

	it("refuses a reference on a list with no table, and a value its key cannot take", () => {
		const byRef = createCursor({ id: 3, title: new CursorRef("b") }, sort, SEALED)
		expect(() => cursorWhere({ cursor: byRef, keys, options: SEALED, sort, table: undefined, tiebreak })).toThrow(
			expect.objectContaining({ status: 500 }),
		)
		const wrong = createCursor({ id: 3, title: 5 }, sort, SEALED)
		expect(() => cursorWhere({ cursor: wrong, keys, options: SEALED, sort, table: doc, tiebreak })).toThrow(
			expect.objectContaining({ errorKey: "invalid_cursor", status: 400 }),
		)
	})
})
