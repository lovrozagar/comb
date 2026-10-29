/**
 * Plan 14's 5.5 (L2 of the 0.13.0 consumers review): a list one org's rows spread over several D1
 * shards, merged in memory. Each shard reads its part with buildListQuery's merged query (K5 of
 * r17), and paginateMerged
 * orders the merge as SQLite's ORDER BY does (text by code point, numbers before text, the null
 * placement the order names, then the id), windows it by page or by cursor, and counts every shard.
 * Read page by page either way, the shards give exactly what one database holding every row gives.
 */
import type { D1Database } from "@cloudflare/workers-types"
import { defineRelations, getTableColumns, ne, type SQL } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { paginateMerged } from "../../../src/sqlite/d1/sharding/index.ts"

const org = sqliteTable("org", { id: text("id").primaryKey(), n: integer("n"), name: text("name") })
/* Q1 of the 0.14.1 review: four null n over three shards, so a page of 2 ends on a null only one shard holds */
const item = sqliteTable("item", { id: text("id").primaryKey(), n: integer("n") })
const relations = defineRelations({ item, org })
const ITEMS: Array<[string, number | null]> = [
	["i1", 1],
	["i2", 2],
	["i3", 3],
	["i4", 4],
	["i5", null],
	["i6", null],
	["i7", null],
	["i8", null],
]
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
		d1Databases: ["NOCASE", "NOCASE2", "S0", "S1", "S2", "WHOLE"],
		modules: true,
		script: "export default { fetch() { return new Response(null, { status: 204 }) } }",
	})
	const dbs = await Promise.all(["S0", "S1", "S2", "WHOLE"].map((name) => mf.getD1Database(name)))
	for (const db of dbs as unknown as D1Database[])
		await db.exec(
			"CREATE TABLE org (id TEXT PRIMARY KEY, n INTEGER, name TEXT); CREATE TABLE item (id TEXT PRIMARY KEY, n INTEGER)",
		)
	for (const [i, [id, n]] of ITEMS.entries())
		for (const db of [dbs[i % 3], dbs[3]] as unknown as D1Database[])
			await db.prepare("INSERT INTO item (id, n) VALUES (?, ?)").bind(id, n).run()
	for (const [i, row] of ROWS.entries()) {
		await insert(dbs[i % 3] as unknown as D1Database, row)
		await insert(dbs[3] as unknown as D1Database, row)
	}
	const [s0, s1, s2, all] = (dbs as unknown as D1Database[]).map((db) => drizzle(db, { relations }))
	shards = [s0, s1, s2] as typeof shards
	whole = all as typeof whole
}, 60_000)
afterAll(() => mf.dispose())

type Db = (typeof shards)[number]
type Table = typeof item | typeof org

/** Every id of `table` under `order`, as one database orders them all */
async function oneDatabase(order: string, table: Table = org, where?: SQL): Promise<string[]> {
	const built = buildListQuery({ ...SEALED, baseWhere: where, parsed: schema.parse({ limit: "3", order }), table })
	const rows = await whole
		.select({ id: table.id })
		.from(table)
		.where(where)
		.orderBy(...built.orderBy)
	return rows.map((row) => row.id)
}

/** One merged page of `table` under `params`: what each shard reads with the merged query, merged */
async function page(
	params: Record<string, string>,
	{ dbs = shards, table = org, where }: { dbs?: readonly Db[]; table?: Table; where?: SQL | undefined } = {},
) {
	const built = buildListQuery({ ...SEALED, baseWhere: where, merged: {}, parsed: schema.parse(params), table })
	const rowsPerShard = await Promise.all(
		dbs.map((db) => applyListQuery((extras) => db.select({ ...getTableColumns(table), ...extras }).from(table), built)),
	)
	return paginateMerged(rowsPerShard, built)
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

/*
 * drizzle declares no collation on a SQLite column, so a sort key is BINARY unless a migration says
 * otherwise; a NOCASE one orders each shard's rows by its fold, which the merge cannot know
 */
/** The NOCASE database holding `rows`, its name column declared COLLATE NOCASE */
const shardOf = async (rows: Array<[string, string]>, database = "NOCASE") => {
	const db = (await mf.getD1Database(database)) as unknown as D1Database
	await db.exec("DROP TABLE IF EXISTS org; CREATE TABLE org (id TEXT PRIMARY KEY, n INTEGER, name TEXT COLLATE NOCASE)")
	for (const [id, name] of rows) await insert(db, [id, null, name])
	return drizzle(db, { relations })
}

describe("paginateMerged and a sort key SQLite does not order BINARY (5.5)", () => {
	it("refuses a shard whose own rows come back out of the order the merge compares by", async () => {
		const shard = await shardOf([
			["o1", "B"],
			["o2", "a"],
		])
		await expect(page({ order: "name.asc" }, { dbs: [shard] })).rejects.toThrow(
			expect.objectContaining({ errorKey: "sort_not_wired" }),
		)
	})

	/* the known limit: no shard sees the pair out of order, so the merge orders it BINARY, where one NOCASE database folds it */
	it("orders by code point a case pair that only rows on different shards hold", async () => {
		const [upper, lower] = [await shardOf([["o1", "B"]]), await shardOf([["o2", "a"]], "NOCASE2")]
		const [items] = await page({ order: "name.asc" }, { dbs: [upper, lower] })
		expect(items.map((row) => row.id)).toEqual(["o1", "o2"])
	})
})

/* Q1 of the 0.14.1 review; K5 of r17: a filtered merged list too, its filter and window one query */
describe("paginateMerged by cursor past a page that ends on a null key (Q1, K5)", () => {
	const NULL_ORDERS = ["n.asc", "n.desc", "n.asc.nullsfirst", "n.desc.nullslast"]
	it.each(NULL_ORDERS.flatMap((order) => [[order, "all"] as const, [order, "filtered"] as const]))(
		"serves every row of %s once, %s",
		async (order, filter) => {
			const where = filter === "all" ? undefined : ne(item.id, "i2")
			const oracle = await oneDatabase(order, item, where)
			const seen: string[] = []
			let cursor: string | undefined
			for (let n = 0; n < 8; n++) {
				const params = { limit: "2", order, ...(cursor === undefined ? {} : { cursor }) }
				const [items, meta] = await page(params, { table: item, where })
				seen.push(...items.map((row) => row.id))
				if (meta.nextCursor === null) break
				cursor = meta.nextCursor
			}
			expect(seen).toEqual(oracle)
		},
	)
})
