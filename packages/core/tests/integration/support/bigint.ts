/**
 * An INTEGER list keyed past 2^53, paged one row at a time on any SQLite engine (U22). D1's JSON
 * transport and bun:sqlite's default mode read such an integer as a rounded JS number, so a cursor
 * minted there carries a rounded key, and the keyset reads the exact key back from the anchor row.
 * A tiebreak id past 2^53 cannot find its own row, so no cursor is minted from one. No test
 * framework is imported, so vitest and bun:test share it.
 */
import { defineRelations, getTableColumns } from "drizzle-orm"
import { integer, sqliteTable } from "drizzle-orm/sqlite-core"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

export const big = sqliteTable("big", { id: integer("id").primaryKey(), n: integer("n") })
export const bigRelations = defineRelations({ big })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["n"] })

export const CREATE = "CREATE TABLE big (id INTEGER PRIMARY KEY, n INTEGER)"
/* three keys past 2^53 that a lossy read rounds onto each other, between two it reads exactly */
export const KEYS =
	"INSERT INTO big VALUES (1, 1), (2, 9007199254740993), (3, 9007199254740995), (4, 9007199254740997), (5, 100)"
/* two tiebreak ids past 2^53 */
export const IDS = "INSERT INTO big VALUES (9007199254740993, 1), (9007199254740995, 2)"
export const EXPECTED: Record<string, number[]> = { "n.asc": [1, 5, 2, 3, 4], "n.desc": [4, 3, 2, 5, 1] }
/* what a refusal to mint names: how to read the id exactly */
export const EXACTLY = /safeIntegers.*intMode: "bigint".*mode: "bigint".*text id/

/** One page under `order` after `cursor`: its ids and the next cursor */
export type Page = (order: string, cursor: string | undefined) => Promise<{ ids: number[]; next: string | null }>

type Builder = { select(fields: object): { from(table: typeof big): { $dynamic(): never } } }
type Relational = { query: { big: { findMany(options: never): Promise<Array<{ id: number }>> } } }

/** A page read through buildListQuery */
export const viaBuilder =
	(db: Builder): Page =>
	async (order, cursor) => {
		const parsed = schema.parse({ cursor, order })
		const list = buildListQuery({ ...SEALED, parsed, table: big })
		const rows = await applyListQuery((extras) => db.select({ ...getTableColumns(big), ...extras }).from(big), list)
		const [items, meta] = queryHelpers.paginate(rows as Array<{ id: number }>, list)
		return { ids: items.map((row) => row.id), next: meta.nextCursor }
	}

/** A page read through queryHelpers.listOptions and drizzle's findMany */
export const viaRelational =
	(db: Relational): Page =>
	async (order, cursor) => {
		const query = { ...schema.parse({ order }), cursor }
		const listed = queryHelpers.listOptions(query, SEALED)
		const rows = await db.query.big.findMany(listed as never)
		const [items, meta] = queryHelpers.paginate(rows, listed)
		return { ids: items.map((row) => row.id), next: meta.nextCursor }
	}

/** Every page under `order`, at most twelve, so a loop shows as a repeat rather than a hang */
export async function pageAll(page: Page, order: string): Promise<number[]> {
	const seen: number[] = []
	let cursor: string | undefined
	for (let i = 0; i < 12; i++) {
		const { ids, next } = await page(order, cursor)
		seen.push(...ids)
		if (next === null) break
		cursor = next
	}
	return seen
}
