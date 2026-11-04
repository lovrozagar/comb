/**
 * AB3 of area B: a merged list sorted by a seconds-mode timestamp compared its rows' Dates, which
 * drop a fraction below the millisecond SQLite ordered by, so four rows a ten-thousandth of a second
 * apart merged in id order with no error, and two on one shard made a 500 blaming the collation. The
 * list now carries each row's stored seconds, as QL2 carries them on a derived list, and the merge
 * compares those: every row once, in time order. Two rows hold whole seconds, an INTEGER, at either
 * end, so the merge compares an INTEGER's seconds and a REAL's in one unit. Ids are out of key order.
 */
import { createClient } from "@libsql/client"
import { getTableColumns } from "drizzle-orm"
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { paginateMerged } from "../../../src/query/merged.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"

const event = sqliteTable("event", { at: integer("at", { mode: "timestamp" }), id: text("id").primaryKey() })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["at"] })
/* time order: e < d < a < c < b < f */
const ROWS = [
	["d", "1000.0001"],
	["a", "1000.0002"],
	["c", "1000.0003"],
	["b", "1000.0004"],
	["e", "1000"],
	["f", "1001"],
] as const
const SERVED = { asc: ["e", "d", "a", "c", "b", "f"], desc: ["f", "b", "c", "a", "d", "e"] } as const

/** One database holding `rows` */
async function holding(rows: readonly (readonly [string, string])[]): Promise<LibSQLDatabase> {
	const client = createClient({ url: ":memory:" })
	await client.execute("CREATE TABLE event (id TEXT PRIMARY KEY, at INTEGER)")
	for (const [id, at] of rows) await client.execute(`INSERT INTO event VALUES ('${id}', ${at})`)
	return drizzle({ client })
}

/** Every id the list merged from shards of `perShard` rows serves by `at`, one a page, by cursor */
async function served(perShard: number, direction: "asc" | "desc"): Promise<string[]> {
	const dbs = await Promise.all(
		Array.from({ length: ROWS.length / perShard }, (_, i) => holding(ROWS.slice(i * perShard, (i + 1) * perShard))),
	)
	const ids: string[] = []
	let cursor: string | undefined
	for (let n = 1; n <= 12; n++) {
		const parsed = { ...schema.parse({ order: `at.${direction}` }), cursor }
		const list = buildListQuery({ ...SEALED, merged: {}, parsed, table: event })
		const reads = await Promise.all(
			dbs.map((db) =>
				applyListQuery((extras) => db.select({ ...getTableColumns(event), ...extras }).from(event), list),
			),
		)
		const [items, meta] = paginateMerged(reads, list)
		ids.push(...items.map((row) => row.id))
		if (meta.nextCursor === null) return ids
		cursor = meta.nextCursor
	}
	return ids
}

describe("a merged list orders a seconds key by its stored seconds (AB3 of area B; sibling: QL2's derived carriage)", () => {
	it.each([1, 2])("serves every row once in time order, %i rows a shard, asc and desc", async (perShard) => {
		for (const direction of ["asc", "desc"] as const)
			expect(await served(perShard, direction), direction).toEqual(SERVED[direction])
	})
})
