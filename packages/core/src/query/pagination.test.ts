import { inspect } from "node:util"
import { sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { SEALED } from "./__fixtures__/cursor-secret.ts"
import { queryHelpers } from "./drizzle.ts"
import { paginateMerged } from "./merged.ts"
import { paginate } from "./pagination.ts"
import { createListQuerySchema } from "./schema.ts"
import { buildDerivedListQuery, buildListQuery } from "./sqlite/build-list-query.ts"

const post = sqliteTable("post", { id: integer("id").primaryKey(), title: text("title") })
const schema = createListQuerySchema({ pagination: { defaultLimit: 2, maxLimit: 10 }, sort: ["title", "@views"] })
const rows = [
	{ _combId: 1, _total: 3, id: 1, title: "a" },
	{ _combId: 2, _total: 3, id: 2, title: "b" },
	{ _combId: 3, _total: 3, id: 3, title: "c" },
]

/* Q6 of the 0.14.1 review: a computed sort leaves nothing a cursor can resume from */
describe("paginate on a list ordered by a computed sort", () => {
	it("gives no next cursor, the next page by number still there", () => {
		const parsed = schema.parse({ limit: "2", order: "@views.desc" })
		const built = buildListQuery({
			...SEALED,
			computedSorts: { "@views": (dir) => sql`views ${sql.raw(dir)}` },
			parsed,
			table: post,
		})
		expect(paginate(rows, built)[1]).toMatchObject({ hasMore: true, nextCursor: null, page: 1 })
		const byColumn = buildListQuery({
			...SEALED,
			parsed: schema.parse({ limit: "2", order: "title.asc" }),
			table: post,
		})
		expect(paginate(rows, byColumn)[1].nextCursor).toEqual(expect.any(String))
	})
})

/* C2 of the 0.14.1 review: rows past what the built query reads are rows of a query that applied no limit */
describe("paginate on more rows than the built query reads", () => {
	it("refuses them, naming the limit the query asked for", () => {
		const built = buildListQuery({ ...SEALED, parsed: schema.parse({ limit: "1" }), table: post })
		expect(() => paginate(rows, built)).toThrow(
			expect.objectContaining({
				cause:
					"paginate got 3 rows where the built query reads at most 2: apply its limit and offset (applyListQuery does)",
				errorKey: "page_not_wired",
				status: 500,
			}),
		)
		const merged = buildListQuery({ ...SEALED, merged: {}, parsed: schema.parse({ limit: "1" }), table: post })
		expect(() => paginateMerged([rows], merged)).toThrow(expect.objectContaining({ errorKey: "page_not_wired" }))
	})
})

/* the reviewer's ruling on 12.2: a built query is logged and spread; the secret is never a value of it */
describe("a built query, as a log or a response would show it", () => {
	it("holds no part of the cursor secret, from any builder", () => {
		const parsed = schema.parse({ limit: "2", order: "title.asc" })
		const builtQueries = [
			buildListQuery({ ...SEALED, parsed, table: post }),
			buildDerivedListQuery({
				...SEALED,
				idColumn: post.id,
				parsed,
				sortColumns: { "@views": post.id, title: post.title },
			}),
			queryHelpers.listOptions(parsed, SEALED),
			buildListQuery({ ...SEALED, merged: {}, parsed, table: post }),
		]
		const secret = SEALED.cursorSecret
		const parts = [secret, secret.slice(0, 12), secret.slice(-12)]
		for (const built of builtQueries) {
			/* drizzle's SQL holds cycles, so the whole query is shown by inspect; its pagination, which a response could spread, by JSON too */
			const shown = [
				JSON.stringify(built.pagination),
				inspect(built, { depth: Number.POSITIVE_INFINITY, showHidden: true }),
			]
			for (const view of shown) for (const part of parts) expect(view).not.toContain(part)
			expect(built.pagination).toMatchObject({ cursorScope: SEALED.cursorScope })
		}
	})
})
