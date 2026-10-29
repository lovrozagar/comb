/**
 * C15 of the 0.14.1 review: searchText folds in JS, which no SQL can express, so a `_search`
 * column is refolded by reading each row and writing its fold back. refoldStatements is that
 * backfill, pure, on a real libsql database: it writes only the rows whose fold changed.
 */
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import { refoldStatements } from "./refold.ts"
import { searchText } from "./search.ts"

const post = sqliteTable("post", { _search: text("_search"), body: text("body"), id: text("id"), title: text("title") })

let close = () => undefined as void
afterEach(() => close())

/** A libsql database holding `rows` of post, their `_search` as given */
async function database(rows: Array<[string, string | null, string | null, string | null]>) {
	const client = createClient({ url: ":memory:" })
	close = () => client.close()
	await client.execute("CREATE TABLE post (id TEXT PRIMARY KEY, title TEXT, body TEXT, _search TEXT)")
	for (const row of rows) await client.execute({ args: row, sql: "INSERT INTO post VALUES (?, ?, ?, ?)" })
	return drizzle({ client })
}

describe("refoldStatements", () => {
	it("writes each row's fold of its sources, only where the stored text differs, and nothing on a second run", async () => {
		const db = await database([
			["a", "Straße", "Ελλάς", "strasse ελλασ"],
			["b", "Ｆｉｌｅ", null, "stale"],
			["c", null, null, "stale"],
		])
		const refold = refoldStatements(post, post._search, [post.title, post.body])
		const updates = refold.updates(await db.all(refold.select))
		expect(updates).toHaveLength(2)
		for (const update of updates) await db.run(update)
		const rows = await db.select().from(post).orderBy(post.id)
		expect(rows.map((row) => row._search)).toEqual([searchText("Straße", "Ελλάς"), searchText("Ｆｉｌｅ"), ""])
		expect(refold.updates(await db.all(refold.select))).toEqual([])
	})
})
