/**
 * D1 binds at most 100 parameters per statement. The largest request the list query schema
 * accepts, by the caps it publishes, must still run there.
 */
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import * as z from "zod"
import { readCombQueryMeta } from "../../../src/meta.ts"
import { createCursor } from "../../../src/query/cursor.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { likeSearch } from "../../../src/query/sqlite/search.ts"
import { type D1Harness, d1Memory } from "../support/d1.ts"

const post = sqliteTable("post", {
	_search: text("_search").notNull(),
	created_at: integer("created_at").notNull(),
	id: integer("id").primaryKey(),
	minute_read: integer("minute_read").notNull(),
	title: text("title").notNull(),
})

const schema = createListQuerySchema({
	filter: { id: "number", minute_read: "number", title: "string" },
	search: ["title"],
	sort: ["created_at", "minute_read", "title"],
})

let harness: D1Harness | undefined
afterEach(async () => {
	await harness?.dispose()
	harness = undefined
})

/** The most bound values a filter may carry, as the published caps allow, spread over in-lists */
function largestFilter(): string {
	const meta = readCombQueryMeta(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }))
	const conditions = meta?.maxFilterConditions ?? 20
	const perList = meta?.maxInValues ?? 100
	let left = meta?.maxFilterValues ?? conditions * perList
	const terms: string[] = []
	while (left > 0 && terms.length < conditions) {
		const size = Math.min(perList, left)
		const term = `id.in.(${Array.from({ length: size }, () => 0).join(",")})`
		/* the filter string is capped at 2048 characters before it is parsed (README) */
		if ([...terms, term].join(",").length > 2048) break
		terms.push(term)
		left -= size
	}
	return terms.join(",")
}

function longestSearch(): string {
	const meta = readCombQueryMeta(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }))
	return Array.from({ length: meta?.maxSearchTerms ?? 100 }, () => "a").join(" ")
}

describe("the worst-case accepted list request runs on D1 (S-11)", () => {
	it("binds no more than D1 allows: full filter, full search, three-key cursor", async () => {
		harness = await d1Memory()
		await harness.CORE.exec(
			"CREATE TABLE post (id integer PRIMARY KEY, title text NOT NULL, minute_read integer NOT NULL, created_at integer NOT NULL, _search text NOT NULL)",
		)
		const order = "created_at.desc,minute_read.asc,title.asc"
		const sort = schema.parse({ order }).parsedSort
		const cursor = createCursor({ created_at: 1, id: 1, minute_read: 1, title: "t" }, sort)
		const result = schema.safeParse({ cursor, filter: largestFilter(), order, q: longestSearch() })
		expect(result.success).toBe(true)
		const query = buildListQuery({ parsed: result.data as never, search: likeSearch(post._search), table: post })
		const db = drizzle(harness.CORE)
		await expect(applyListQuery(db.select().from(post).$dynamic(), query)).resolves.toEqual([])
	})
})
