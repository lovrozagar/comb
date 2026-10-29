/**
 * A cursor fits whatever the driver returned for its column (R3): libsql with `intMode: "bigint"`
 * returns every INTEGER as a bigint, and a derived time key selected as `sql<number>` returns epoch
 * milliseconds. Each column kind is paged through `paginate`, then the builder, on each mode, and
 * every row comes back once, in the order one query gives.
 */
import { createClient } from "@libsql/client"
import { getTableColumns, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

const item = sqliteTable("item", {
	at: integer("at", { mode: "timestamp_ms" }).notNull(),
	big: integer("big").notNull(),
	id: integer("id").primaryKey(),
	n: integer("n").notNull(),
	ok: integer("ok", { mode: "boolean" }).notNull(),
	r: real("r").notNull(),
	t: text("t").notNull(),
})
/* drizzle's timestamp_ms column cannot read a bigint, so bigint mode pages a table without it */
const { at: _at, ...withoutTime } = {
	at: integer("at", { mode: "timestamp_ms" }).notNull(),
	big: integer("big").notNull(),
	id: integer("id").primaryKey(),
	n: integer("n").notNull(),
	ok: integer("ok", { mode: "boolean" }).notNull(),
	r: real("r").notNull(),
	t: text("t").notNull(),
}
const itemNoTime = sqliteTable("item", withoutTime)
const FIELDS = ["at", "big", "n", "ok", "r", "t"] as const
const schema = createListQuerySchema({ sort: [...FIELDS], pagination: { defaultLimit: 2, maxLimit: 2 } })
const tableFor = (intMode: "bigint" | "number") => (intMode === "bigint" ? itemNoTime : item)

/** A database of five rows on libsql in `intMode` */
async function database(intMode: "bigint" | "number") {
	const client = createClient({ intMode, url: ":memory:" })
	/* past 2^53 only where the driver can return it: number mode refuses such an integer outright */
	const huge = (offset: number) => (intMode === "bigint" ? `${9007199254740990n + BigInt(offset)}` : `${1000 + offset}`)
	await client.executeMultiple(`CREATE TABLE item (id INTEGER PRIMARY KEY, n INTEGER NOT NULL, r REAL NOT NULL, t TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL, big INTEGER NOT NULL);
INSERT INTO item VALUES (1, 30, 1.5, 'c', 1700000000300, 1, ${huge(3)}), (2, 10, 0.5, 'a', 1700000000100, 0, 5), (3, 50, 2.5, 'e', 1700000000500, 1, 7), (4, 20, 9.5, 'b', 1700000000200, 0, ${huge(5)}), (5, 40, 4.5, 'd', 1700000000400, 1, 6);`)
	return { client, db: drizzle({ client }) }
}

/** Every id, page by page of two, under `order` */
async function pageAll(
	db: ReturnType<typeof drizzle>,
	order: string,
	table: typeof item | typeof itemNoTime,
): Promise<string[]> {
	const ids: string[] = []
	let cursor: string | undefined
	for (let guard = 0; guard < 6; guard++) {
		const parsed = schema.parse({ cursor, order })
		const list = buildListQuery({ ...SEALED, parsed, table })
		const rows = await applyListQuery((extras) => db.select({ ...getTableColumns(table), ...extras }).from(table), list)
		const [items, pagination] = queryHelpers.paginate(rows, list)
		ids.push(...items.map((row) => String(row.id)))
		if (pagination.nextCursor === null) return ids
		cursor = pagination.nextCursor
	}
	throw new Error(`${order} did not end`)
}

describe("a cursor fits what the driver returned (R3)", () => {
	for (const intMode of ["number", "bigint"] as const) {
		const fields = FIELDS.filter((field) => intMode === "number" || field !== "at")
		it.each(fields.flatMap((field) => [`${field}.asc`, `${field}.desc`]))(
			`pages %s on libsql intMode ${intMode}: every row once, in order`,
			async (order) => {
				const { client, db } = await database(intMode)
				try {
					const [field, direction] = order.split(".") as [(typeof FIELDS)[number], "asc" | "desc"]
					const once = await db.all<{ id: unknown }>(
						sql.raw(`SELECT id FROM item ORDER BY ${field} ${direction}, id ${direction}`),
					)
					expect(await pageAll(db, order, tableFor(intMode))).toEqual(once.map((row) => String(row.id)))
				} finally {
					client.close()
				}
			},
		)
	}

	it.each(["number", "bigint"] as const)(
		"pages a derived time key selected as sql<number>, on intMode %s",
		async (intMode) => {
			const { client, db } = await database(intMode)
			try {
				const latest = { sql: sql`max(${item.at})`, type: "date" as const }
				const sort = [{ direction: "desc" as const, field: "latest" }]
				const ids: string[] = []
				let cursor: string | undefined
				for (let guard = 0; guard < 6; guard++) {
					const built = buildDerivedListQuery({
						...SEALED,
						idColumn: item.t,
						parsed: { cursor, limit: 2, parsedSort: sort },
						sortColumns: { latest },
					})
					const query = db
						.select({ id: item.t, latest: sql<number>`max(${item.at})`, ...built.extras })
						.from(item)
						.groupBy(item.t)
						.$dynamic()
					const rows = await (built.where ? query.having(built.where) : query)
						.orderBy(...built.orderBy)
						.limit(built.limit)
					const [items, pagination] = queryHelpers.paginate(rows, built)
					ids.push(...items.map((row) => row.id))
					if (pagination.nextCursor === null) break
					cursor = pagination.nextCursor
				}
				expect(ids).toEqual(["e", "d", "c", "b", "a"])
			} finally {
				client.close()
			}
		},
	)
})
