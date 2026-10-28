/**
 * Plan 14's 5.5 (L2 of the 0.13.0 consumers review): a list one org's rows spread over several D1
 * shards, merged in memory. Each shard reads its part through mergedListOptions, and paginateMerged
 * orders the merge as SQLite's ORDER BY does (text by code point, numbers before text, the null
 * placement the order names, then the id), windows it by page or by cursor, and counts every shard.
 * Read page by page either way, the shards give exactly what one database holding every row gives.
 */
import type { D1Database } from "@cloudflare/workers-types"
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { mergedListOptions, paginateMerged } from "../../../src/sqlite/d1/sharding/index.ts"

const org = sqliteTable("org", { id: text("id").primaryKey(), n: integer("n"), name: text("name") })
const relations = defineRelations({ org })
const schema = createListQuerySchema({ pagination: { defaultLimit: 2, maxLimit: 3 }, sort: ["n", "name"] })

/*
 * names SQLite's BINARY order and JS's `<` disagree on (U+FFFD before an emoji by code point, after
 * it by UTF-16 code unit), a case pair, a tie on every key, and nulls; spread over three shards
 */
const ROWS: Array<[string, number | null, string | null]> = [
	["o01", 3, "�b"],
	["o02", 1, "\u{1F600}a"],
	["o03", null, "B"],
	["o04", 2, "a"],
	["o05", 2, "a"],
	["o06", null, null],
	["o07", 1, "B"],
	["o08", 5, null],
	["o09", 3, "\u{1F600}a"],
	["o10", 4, "zz"],
	["o11", 2, "aa"],
]

let mf: Miniflare

/** One row of ROWS into `db` */
const insert = (db: D1Database, [id, n, name]: (typeof ROWS)[number]) =>
	db.prepare("INSERT INTO org (id, n, name) VALUES (?, ?, ?)").bind(id, n, name).run()
let shards: Array<ReturnType<typeof drizzle<typeof relations>>>
let whole: ReturnType<typeof drizzle<typeof relations>>

beforeAll(async () => {
	mf = new Miniflare({
		d1Databases: ["S0", "S1", "S2", "WHOLE"],
		modules: true,
		script: "export default { fetch() { return new Response(null, { status: 204 }) } }",
	})
	const dbs = await Promise.all(["S0", "S1", "S2", "WHOLE"].map((name) => mf.getD1Database(name)))
	for (const db of dbs as unknown as D1Database[])
		await db.exec("CREATE TABLE org (id TEXT PRIMARY KEY, n INTEGER, name TEXT)")
	for (const [i, row] of ROWS.entries()) {
		await insert(dbs[i % 3] as unknown as D1Database, row)
		await insert(dbs[3] as unknown as D1Database, row)
	}
	const [s0, s1, s2, all] = (dbs as unknown as D1Database[]).map((db) => drizzle(db, { relations }))
	shards = [s0, s1, s2] as typeof shards
	whole = all as typeof whole
}, 60_000)
afterAll(() => mf.dispose())

/** Every id under `order`, as one database orders them all */
async function oneDatabase(order: string): Promise<string[]> {
	const parsed = schema.parse({ limit: "3", order })
	const rows = await whole.query.org.findMany({ orderBy: mergedListOptions(parsed, SEALED).orderBy } as never)
	return (rows as Array<{ id: string }>).map((row) => row.id)
}

/** One merged page under `params`: what the shards hold of it, merged */
async function page(params: Record<string, string>) {
	const parsed = schema.parse(params)
	const options = mergedListOptions(parsed, SEALED)
	const rowsPerShard = await Promise.all(shards.map((db) => db.query.org.findMany(options as never)))
	return paginateMerged(rowsPerShard as Array<Array<{ id: string }>>, parsed, SEALED)
}

const ORDERS = ["name.asc", "name.desc", "n.asc,name.desc", "n.desc.nullslast,name.asc.nullsfirst", "n.asc.nullsfirst"]

describe("paginateMerged over three D1 shards (5.5)", () => {
	it.each(ORDERS)("pages %s by number as one database orders it, counting every shard", async (order) => {
		const expected = await oneDatabase(order)
		const seen: string[] = []
		for (let n = 1; n <= 6; n++) {
			const [items, meta] = await page({ limit: "3", order, page: String(n) })
			expect(meta).toMatchObject({ count: ROWS.length, limit: 3, page: n })
			expect(meta.hasMore).toBe(n * 3 < ROWS.length)
			seen.push(...items.map((row) => row.id))
			if (!meta.hasMore) break
		}
		expect(seen).toEqual(expected)
	})

	it.each(ORDERS)("pages %s by cursor as one database orders it", async (order) => {
		const expected = await oneDatabase(order)
		const seen: string[] = []
		let cursor: string | undefined
		for (let n = 0; n < 6; n++) {
			const [items, meta] = await page({ limit: "3", order, ...(cursor === undefined ? {} : { cursor }) })
			/* the first page, which no cursor names, is an offset page, which counts */
			expect(meta.count).toBe(cursor === undefined ? ROWS.length : null)
			seen.push(...items.map((row) => row.id))
			if (meta.nextCursor === null) break
			cursor = meta.nextCursor
		}
		expect(seen).toEqual(expected)
	})

	it("answers a page past the end empty, with the count still known", async () => {
		const [items, meta] = await page({ limit: "3", order: "name.asc", page: "9" })
		expect(items).toEqual([])
		expect(meta).toMatchObject({ count: ROWS.length, hasMore: false, nextCursor: null, page: 9 })
	})
})
