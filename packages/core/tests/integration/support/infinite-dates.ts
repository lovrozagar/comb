/**
 * 3.24: a SQLite timestamp in seconds or milliseconds mode holding ±Infinity, which bun:sqlite and
 * libsql read back as Infinity and drizzle's date mode turns into an Invalid Date. A cursor carries
 * it as itself, and the keyset reads its bound from the row: exact while the row holds its
 * infinity, the direction's own end once it is gone. Every order is paged through both builders,
 * one and two rows at a time. No test framework is imported, so vitest and bun:test share it.
 */
import { defineRelations } from "drizzle-orm"
import { integer, sqliteTable } from "drizzle-orm/sqlite-core"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

export const moment = sqliteTable("moment", {
	at: integer("at", { mode: "timestamp" }),
	id: integer("id").primaryKey(),
	ms: integer("ms", { mode: "timestamp_ms" }),
})
export const momentRelations = defineRelations({ moment })
const schema = createListQuerySchema({ sort: ["at", "ms"], pagination: { defaultLimit: 1, maxLimit: 2 } })

/** Each key in both directions, and with the NULLs moved to the other end */
export const MOMENT_ORDERS = ["at.asc", "at.desc", "at.asc.nullsfirst", "ms.asc", "ms.desc", "ms.desc.nullslast"]

/** ±Infinity twice each, finite times on either side, and a NULL, in both columns */
export const MOMENT_SEED = [
	"CREATE TABLE moment (id INTEGER PRIMARY KEY, at INTEGER, ms INTEGER)",
	"INSERT INTO moment VALUES (1, 9e999, 9e999), (2, -9e999, -9e999), (3, 1700000000, 1700000000000), (4, NULL, NULL), (5, 1600000000, 1600000000000), (6, 9e999, 9e999), (7, -9e999, -9e999)",
]
const INFINITE_IDS = new Set([1, 2, 6, 7])

/** What a test runs on one engine */
export type MomentEngine = {
	exec(statement: string): Promise<void>
	ids(query: string): Promise<number[]>
}

/** One page under `order` after `cursor`, `limit` rows long: its ids and the next cursor */
export type MomentPage = (
	order: string,
	cursor: string | undefined,
	limit: number,
) => Promise<{ ids: number[]; next: string | null }>

type Builder = { select(): { from(table: typeof moment): { $dynamic(): never } } }
type Relational = { query: { moment: { findMany(options: never): Promise<unknown[]> } } }

/** A page read through buildListQuery */
export const momentsViaBuilder =
	(db: Builder): MomentPage =>
	async (order, cursor, limit) => {
		const parsed = schema.parse({ cursor, limit: String(limit), order })
		const rows = await applyListQuery(
			db.select().from(moment).$dynamic(),
			buildListQuery({ ...SEALED, parsed, table: moment }),
		)
		const [items, meta] = queryHelpers.paginate(rows as Array<{ id: number }>, parsed, SEALED)
		return { ids: items.map((row) => row.id), next: meta.nextCursor }
	}

/** A page read through queryHelpers.listOptions and drizzle's findMany */
export const momentsViaRelational =
	(db: Relational): MomentPage =>
	async (order, cursor, limit) => {
		const query = { ...schema.parse({ limit: String(limit), order }), cursor }
		const rows = await db.query.moment.findMany(queryHelpers.listOptions(query, SEALED) as never)
		const [items, meta] = queryHelpers.paginate(rows as Array<{ id: number }>, query, SEALED)
		return { ids: items.map((row) => row.id), next: meta.nextCursor }
	}

/** The ids SQLite itself lists under `order` */
export function momentsInOrder(engine: MomentEngine, order: string): Promise<number[]> {
	const [column, direction, nulls] = order.split(".") as [string, string, string | undefined]
	const first = nulls === undefined ? direction === "desc" : nulls === "nullsfirst"
	return engine.ids(
		`SELECT id FROM moment ORDER BY ${column} ${direction} NULLS ${first ? "FIRST" : "LAST"}, id ${direction}`,
	)
}

/**
 * Every id `page` serves under `order`, `limit` at a time; with `deleteInfinite`, the first anchor
 * holding ±Infinity a page ends on is deleted before the next page, and its id is `deleted`
 */
export async function pageMoments(
	engine: MomentEngine,
	page: MomentPage,
	{ deleteInfinite = false, limit, order }: { deleteInfinite?: boolean; limit: number; order: string },
): Promise<{ deleted: number | undefined; seen: number[] }> {
	const seen: number[] = []
	let deleted: number | undefined
	let cursor: string | undefined
	for (let guard = 0; guard < 20; guard++) {
		const { ids, next } = await page(order, cursor, limit)
		seen.push(...ids)
		if (next === null) return { deleted, seen }
		const last = ids.at(-1) as number
		if (deleteInfinite && deleted === undefined && INFINITE_IDS.has(last)) {
			deleted = last
			await engine.exec(`DELETE FROM moment WHERE id = ${last}`)
		}
		cursor = next
	}
	throw new Error(`${order} did not end in 20 pages: ${seen.join(" ")}`)
}
