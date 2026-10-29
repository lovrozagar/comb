/**
 * U21: D1 refuses a LIKE or GLOB pattern over 50 bytes. A search term and a `like`/`ilike` value
 * whose only `*` are at its ends are fixed texts, found by instr, substr or `=`, which no cap
 * limits; a pattern with an inner `*` over the cap is the client's to shorten, a 400 naming it.
 */
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import { CombError } from "../../../src/error.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { likeSearch, searchText } from "../../../src/query/sqlite/search.ts"
import { classifyD1Error } from "../../../src/sqlite/d1/error-handler.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { type D1Harness, d1Memory } from "../support/d1.ts"

const post = sqliteTable("post", { _search: text("_search"), id: integer("id").primaryKey(), title: text("title") })
const schema = createListQuerySchema({ filter: { title: "string" }, search: ["title"], sort: ["id"] })

const SLUG = "how-to-run-postgres-17-on-a-laptop-without-docker"
const CJK = "東京都庁舎東京都庁舎東京都庁舎東京"
/* astral characters, one code point and two UTF-16 units each, which a prefix's length counts as SQLite does (Q2) */
const ASTRAL = "😀b😀"
const TITLES: Array<string | null> = [SLUG, CJK, "Ab-cd", null, ASTRAL]

let harness: D1Harness | undefined
afterEach(async () => {
	await harness?.dispose()
	harness = undefined
})

/** The ids of the rows the list request `params` answers, on a D1 holding TITLES as ids 1 to 5 */
async function ids(params: Record<string, string>): Promise<number[]> {
	harness ??= await d1Memory()
	await harness.CORE.exec("CREATE TABLE IF NOT EXISTS post (id integer PRIMARY KEY, title text, _search text)")
	await harness.CORE.exec("DELETE FROM post")
	for (const [i, title] of TITLES.entries())
		await harness.CORE.prepare("INSERT INTO post VALUES (?, ?, ?)")
			.bind(i + 1, title, title === null ? null : searchText(title))
			.run()
	const query = buildListQuery({
		...SEALED,
		parsed: schema.parse({ order: "id.asc", ...params }) as never,
		search: likeSearch(post._search),
		table: post,
	})
	const rows = await applyListQuery(drizzle(harness.CORE).select().from(post).$dynamic(), query)
	return rows.map((row) => row.id)
}

describe("a fixed text on D1, past its LIKE cap (U21)", () => {
	it("finds a search term of 17 CJK characters, 53 bytes folded", async () => {
		expect(await ids({ q: CJK })).toEqual([2])
	})

	it("finds a like and an ilike value on a 49-character slug", async () => {
		expect(await ids({ filter: `title.like.*${SLUG}*` })).toEqual([1])
		expect(await ids({ filter: `title.ilike.*${SLUG.toUpperCase()}*` })).toEqual([1])
	})

	it("matches each fixed shape as GLOB and LIKE did, a NULL never, like by case and ilike without", async () => {
		const shapes: Array<[string, number[]]> = [
			["title.like.*", [1, 2, 3, 5]],
			["title.like.Ab*", [3]],
			["title.like.ab*", []],
			["title.ilike.ab*", [3]],
			["title.like.*-cd", [3]],
			["title.like.*o-ru*", [1]],
			["title.like.Ab-cd", [3]],
			["title.ilike.AB-CD", [3]],
			["title.like.東京都*", [2]],
			["title.like.*庁舎東京", [2]],
			["title.like.😀b*", [5]],
			["title.ilike.😀B*", [5]],
			["title.like.*b😀", [5]],
		]
		for (const [filter, expected] of shapes) expect(await ids({ filter }), filter).toEqual(expected)
	})
})

describe("a pattern on D1 past its LIKE cap (U21)", () => {
	it("answers a 400 that names the cap, where it was a 500", async () => {
		const error = await ids({ filter: `title.like.how*${SLUG}` }).catch((caught: unknown) => caught)
		const classified = classifyD1Error(error, [])
		expect(classified).toBeInstanceOf(CombError)
		expect([classified?.status, classified?.errorKey]).toEqual([400, "invalid_value"])
		expect(String(classified?.cause)).toContain("50 bytes")
	})
})
