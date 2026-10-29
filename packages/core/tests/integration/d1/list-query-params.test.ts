/**
 * D1 binds at most 100 parameters per statement. The largest request the list query schema
 * accepts, by the caps it publishes, must still run there.
 */
import { inArray, type SQL } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import * as z from "zod"
import { readCombQueryMeta } from "../../../src/meta.ts"
import { createCursor } from "../../../src/query/cursor-mint.ts"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { likeSearch } from "../../../src/query/sqlite/search.ts"
import { type D1Harness, d1Memory } from "../support/d1.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

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
		const cursor = createCursor({ created_at: 1, id: 1, minute_read: 1, title: "t" }, sort, SEALED)
		const result = schema.safeParse({ cursor, filter: largestFilter(), order, q: longestSearch() })
		expect(result.success).toBe(true)
		const query = buildListQuery({
			...SEALED,
			parsed: result.data as never,
			search: likeSearch(post._search),
			table: post,
		})
		const db = drizzle(harness.CORE)
		await expect(applyListQuery(db.select().from(post).$dynamic(), query)).resolves.toEqual([])
	})

	/* U1 of the 0.12 round: a key the cursor carries by reference keeps within the same budget */
	it.each(["created_at.desc,minute_read.asc,title.asc", "title.asc,created_at.desc,minute_read.asc"])(
		"binds no more than D1 allows with a long title carried by reference, sorted %s",
		async (order) => {
			harness = await d1Memory()
			await harness.CORE.exec(
				"CREATE TABLE post (id integer PRIMARY KEY, title text NOT NULL, minute_read integer NOT NULL, created_at integer NOT NULL, _search text NOT NULL)",
			)
			const sort = schema.parse({ order }).parsedSort
			const row = { created_at: 1, id: 1, minute_read: 1, title: "長".repeat(3000) }
			const [, meta] = queryHelpers.paginate([row, { ...row, id: 2 }], { limit: 1, parsedSort: sort }, SEALED)
			const result = schema.safeParse({ cursor: meta.nextCursor, filter: largestFilter(), order, q: longestSearch() })
			expect(result.success).toBe(true)
			const query = buildListQuery({
				...SEALED,
				parsed: result.data as never,
				search: likeSearch(post._search),
				table: post,
			})
			const db = drizzle(harness.CORE)
			await expect(applyListQuery(db.select().from(post).$dynamic(), query)).resolves.toEqual([])
		},
	)
})

/** The `i`th prefix or suffix condition, like and ilike in turn */
const term = (i: number) => `title.${i % 2 === 0 ? "like" : "ilike"}.${i % 4 < 2 ? `p${i}*` : `*s${i}`}`

/**
 * The filter the published caps allow that binds the most: every condition but one a prefix or
 * suffix text, which the budget counts as one value, and the last an in-list of the values left
 */
function fixedTexts(): string {
	const meta = readCombQueryMeta(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }))
	const [conditions, values] = [meta?.maxFilterConditions ?? 20, meta?.maxFilterValues ?? 60]
	const texts = Array.from({ length: conditions - 1 }, (_, i) => term(i))
	const left = Math.min(values - texts.length, meta?.maxInValues ?? 100)
	return [...texts, `id.in.(${Array.from({ length: left }, () => 0).join(",")})`].join(",")
}

/* Q2, C10 of the 0.14.1 review: a prefix or suffix filter binds its text, which the budget counts once */
describe("the worst accepted list request by prefix and suffix filters (Q2)", () => {
	it("binds at most 80, and runs on D1 beside a 20-value baseWhere", async () => {
		harness = await d1Memory()
		await harness.CORE.exec(
			"CREATE TABLE post (id integer PRIMARY KEY, title text NOT NULL, minute_read integer NOT NULL, created_at integer NOT NULL, _search text NOT NULL)",
		)
		const order = "created_at.desc,minute_read.asc,title.asc"
		const sort = schema.parse({ order }).parsedSort
		const cursor = createCursor({ created_at: 1, id: 1, minute_read: 1, title: "t" }, sort, SEALED)
		const result = schema.safeParse({ cursor, filter: fixedTexts(), order, q: longestSearch() })
		expect(result.success).toBe(true)
		const build = (baseWhere?: SQL) =>
			buildListQuery({
				...SEALED,
				baseWhere,
				parsed: result.data as never,
				search: likeSearch(post._search),
				table: post,
			})
		const db = drizzle(harness.CORE)
		expect(applyListQuery(db.select().from(post).$dynamic(), build()).toSQL().params.length).toBeLessThanOrEqual(80)
		const twenty = inArray(
			post.minute_read,
			Array.from({ length: 20 }, (_, i) => i),
		)
		await expect(applyListQuery(db.select().from(post).$dynamic(), build(twenty))).resolves.toEqual([])
	})
})
