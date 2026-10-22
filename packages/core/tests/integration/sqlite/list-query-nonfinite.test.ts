/**
 * A SQLite REAL holds ±Infinity (R4), which JSON writes as null and libsql refuses to bind. Each
 * key is paged one row at a time, through the SQL builder and the relational helper, and every
 * row comes back once, in the order SQLite gives.
 */
import { defineRelations, sql } from "drizzle-orm"
import { integer, real, sqliteTable } from "drizzle-orm/sqlite-core"
import { drizzle } from "drizzle-orm/libsql"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { libsqlMemory } from "../support/libsql.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

const point = sqliteTable("point", { id: integer("id").primaryKey(), x: real("x") })
const schema = createListQuerySchema({ sort: ["x"], pagination: { defaultLimit: 1, maxLimit: 1 } })
const ORDERS = ["x.asc", "x.desc", "x.asc.nullsfirst", "x.desc.nullslast"]

/** A database holding ±Infinity twice each, finite values and a NULL */
async function seeded() {
	const harness = libsqlMemory()
	await harness.client.executeMultiple(`CREATE TABLE point (id INTEGER PRIMARY KEY, x REAL);
INSERT INTO point VALUES (1, 9e999), (2, -9e999), (3, 1.5), (4, NULL), (5, -2), (6, 9e999), (7, -9e999);`)
	return harness
}

/** What SQLite itself orders `order` as */
async function sqliteOrder(harness: Awaited<ReturnType<typeof seeded>>, order: string): Promise<number[]> {
	const [, direction, nulls] = order.split(".") as [string, string, string | undefined]
	const placement =
		nulls === "nullsfirst"
			? "NULLS FIRST"
			: nulls === "nullslast"
				? "NULLS LAST"
				: direction === "asc"
					? "NULLS LAST"
					: "NULLS FIRST"
	const rows = await harness.db.all<{ id: number }>(
		sql.raw(`SELECT id FROM point ORDER BY x ${direction} ${placement}, id ${direction}`),
	)
	return rows.map((row) => row.id)
}

/** Every id under `order`, page by page, read by `page` */
async function pageAll(page: (cursor: string | undefined) => Promise<{ ids: number[]; next: string | null }>) {
	const seen: number[] = []
	let cursor: string | undefined
	for (let guard = 0; guard < 12; guard++) {
		const { ids, next } = await page(cursor)
		seen.push(...ids)
		if (next === null) return seen
		cursor = next
	}
	throw new Error("did not end in 12 pages")
}

describe("keyset pagination on ±Infinity in a SQLite REAL (R4)", () => {
	it.each(ORDERS)("pages %s through buildListQuery every row once", async (order) => {
		const harness = await seeded()
		try {
			const seen = await pageAll(async (cursor) => {
				const parsed = schema.parse({ cursor, order })
				const rows = await applyListQuery(
					harness.db.select().from(point).$dynamic(),
					buildListQuery({ ...SEALED, parsed, table: point }),
				)
				const [items, meta] = queryHelpers.paginate(rows, parsed, SEALED)
				return { ids: items.map((row) => row.id), next: meta.nextCursor }
			})
			expect(seen).toEqual(await sqliteOrder(harness, order))
		} finally {
			harness.close()
		}
	})

	it.each(ORDERS)("pages %s through queryHelpers.listOptions every row once", async (order) => {
		const harness = await seeded()
		try {
			const db = drizzle({ client: harness.client, relations: defineRelations({ point }) })
			const seen = await pageAll(async (cursor) => {
				const query = { ...schema.parse({ order }), cursor }
				const rows = await db.query.point.findMany(queryHelpers.listOptions(query, SEALED) as never)
				const [items, meta] = queryHelpers.paginate(rows as Array<{ id: number }>, query, SEALED)
				return { ids: items.map((row) => row.id), next: meta.nextCursor }
			})
			expect(seen).toEqual(await sqliteOrder(harness, order))
		} finally {
			harness.close()
		}
	})
})
