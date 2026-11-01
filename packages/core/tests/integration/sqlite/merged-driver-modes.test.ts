/**
 * Q2 of r19, the merged sibling: a merged list over libsql shards, on each intMode. intMode "string"
 * reads an INTEGER as a decimal string, so the merge compared 12 before 3 by code point and refused
 * every page as a collation fault; it compares a number column's canonical integer string as the
 * integer it is, as each shard's ORDER BY did.
 */
import { createClient } from "@libsql/client"
import { getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { paginateMerged } from "../../../src/query/merged.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"

const org = sqliteTable("org", { id: integer("id").primaryKey(), n: integer("n").notNull(), t: text("t").notNull() })
const schema = createListQuerySchema({ pagination: { defaultLimit: 2, maxLimit: 10 }, sort: ["n", "t"] })
/* keys that cross a digit boundary, and a tiebreak id that does, on two shards */
const SHARDS = [
	"INSERT INTO org VALUES (3, 3, 'b'), (12, 12, 'a')",
	"INSERT INTO org VALUES (7, 7, 'd'), (100, 100, 'c'), (25, 25, 'e'), (9, 12, 'f')",
]
const ASC = ["3", "7", "9", "12", "25", "100"]

/** Every id of the merged list under `order`, by page number or by cursor */
async function pageAll(intMode: "bigint" | "number" | "string", order: string, by: "cursor" | "offset") {
	const dbs = await Promise.all(
		SHARDS.map(async (seed) => {
			const client = createClient({ intMode, url: ":memory:" })
			await client.executeMultiple(
				`CREATE TABLE org (id INTEGER PRIMARY KEY, n INTEGER NOT NULL, t TEXT NOT NULL); ${seed}`,
			)
			return drizzle({ client })
		}),
	)
	const ids: string[] = []
	let cursor: string | undefined
	for (let page = 1; page <= 8; page++) {
		const parsed = schema.parse(by === "offset" ? { order, page: String(page) } : { cursor, order })
		const list = buildListQuery({ ...SEALED, merged: {}, parsed, table: org })
		const reads = await Promise.all(
			dbs.map((db) => applyListQuery((extras) => db.select({ ...getTableColumns(org), ...extras }).from(org), list)),
		)
		const [items, meta] = paginateMerged(reads, list)
		ids.push(...items.map((row) => String(row.id)))
		if (by === "offset" ? !meta.hasMore : meta.nextCursor === null) return { count: meta.count, ids }
		cursor = meta.nextCursor ?? undefined
	}
	throw new Error(`${order} did not end`)
}

describe("a merged list over libsql shards, on each intMode", () => {
	for (const intMode of ["number", "bigint", "string"] as const)
		for (const by of ["offset", "cursor"] as const)
			it.each([
				["n.asc", ASC],
				["n.desc", ["100", "25", "12", "9", "7", "3"]],
			])(`pages %s by ${by} on intMode ${intMode}, every row once in the shards' order`, async (order, want) => {
				expect((await pageAll(intMode, order, by)).ids).toEqual(want)
			})
})
