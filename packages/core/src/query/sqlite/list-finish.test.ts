/**
 * The shared tail of the SQLite list builders: the page window, merged or not, and the cursor
 * pagination a list with no keyset refuses. The builders' own behavior is build-list-query.test.ts's.
 */
import { sql } from "drizzle-orm"
import { integer, sqliteTable } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { SEALED } from "../__fixtures__/cursor-secret.ts"
import { createCursor } from "../cursor-mint.ts"
import { finish } from "./list-finish.ts"

const t = sqliteTable("t", { id: integer("id").primaryKey() })
const tiebreak = { column: t.id, direction: "desc" as const }

/** finish over `t`, its order the tiebreak alone, with `over` in place of any default */
const finished = (over: Partial<Parameters<typeof finish>[0]> = {}) =>
	finish({
		cursor: SEALED,
		keyset: { keys: [], orderBy: [sql`1`] },
		parsed: { limit: 2, parsedSort: [] },
		sort: [],
		table: t,
		tiebreak,
		where: [],
		...over,
	})

describe("finish", () => {
	it("reads one past the page from its offset, or every row to the page's end from each shard of a merged list", () => {
		expect(finished({ parsed: { limit: 2, page: 3, parsedSort: [] } })).toMatchObject({ limit: 3, offset: 4 })
		expect(finished({ merged: {}, parsed: { limit: 2, page: 3, parsedSort: [] } })).toMatchObject({
			limit: 7,
			offset: 0,
		})
		expect(() => finished({ merged: { maxRowsPerShard: 6 }, parsed: { limit: 2, page: 3, parsedSort: [] } })).toThrow(
			expect.objectContaining({ errorKey: "page_too_deep", status: 400 }),
		)
	})

	it("refuses a cursor on a list no keyset can resume, and selects no tiebreak there", () => {
		const cursor = createCursor({ id: 1 }, [], SEALED)
		expect(() =>
			finished({ keyset: { keys: null, orderBy: [] }, parsed: { cursor, limit: 2, parsedSort: [] } }),
		).toThrow(expect.objectContaining({ errorKey: "cursor_pagination_unsupported", status: 400 }))
		expect(Object.keys(finished({ tiebreak: null }).extras)).toEqual(["_total"])
	})
})
