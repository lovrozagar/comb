/**
 * B2-4 of area B on SQLite: drizzle's `numeric()` reads every value as a string, and a list with no
 * anchor row carries a key under the integer class libsql reads as a bigint, so a page that ended on
 * an integer value (`2`) minted a cursor its own next page refused as `invalid_cursor`, a 400. The
 * column holds a fraction and integers, 0.1 < 2 < 3 < 10, so text order (`10` before `2`) would show
 * too. Ids are out of key order. Each engine's suite runs it on its own driver, and on two shards for
 * the merged list.
 */
import { numeric, type SQLiteAsyncDatabase, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { paginateMerged } from "../../../src/query/merged.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"

const amount = sqliteTable("amount", { id: text("id").primaryKey(), k: numeric("k") })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["k"] })

const CREATE = "CREATE TABLE amount (id TEXT PRIMARY KEY, k NUMERIC)"
const ROWS = ["('d', 0.1)", "('a', 2)", "('c', 3)", "('b', 10)"] as const

/** The statements that seed one database with every row, or one shard of two with its half */
export const NUMERIC_SEED = (shard?: 0 | 1): string[] => [
	CREATE,
	`INSERT INTO amount VALUES ${(shard === undefined ? ROWS : ROWS.filter((_, i) => i % 2 === shard)).join(", ")}`,
]

/** Every id by `k`, ascending and descending */
export const NUMERIC_SERVED = { asc: ["d", "a", "c", "b"], desc: ["b", "c", "a", "d"] } as const

/** Every id the anchorless list over `dbs[0]`, or the merged list over every shard in `dbs`, serves by `k`, one a page, at most eight pages */
export async function servedNumeric(
	dbs: readonly SQLiteAsyncDatabase<any, any>[],
	{ direction, shape }: { direction: "asc" | "desc"; shape: "anchorless" | "merged" },
): Promise<string[]> {
	const ids: string[] = []
	let cursor: string | undefined
	for (let n = 1; n <= 8; n++) {
		const parsed = { ...schema.parse({ order: `k.${direction}` }), cursor }
		const select = (db: SQLiteAsyncDatabase<any, any>) => (extras: object) =>
			db.select({ id: amount.id, k: amount.k, ...extras }).from(amount)
		let page: Record<string, unknown>[]
		let next: string | null
		if (shape === "merged") {
			const list = buildListQuery({ ...SEALED, merged: {}, parsed, table: amount })
			const [items, meta] = paginateMerged(await Promise.all(dbs.map((db) => applyListQuery(select(db), list))), list)
			;[page, next] = [items, meta.nextCursor]
		} else {
			const list = buildDerivedListQuery({ ...SEALED, idColumn: amount.id, parsed, sortColumns: { k: amount.k } })
			const [items, meta] = queryHelpers.paginate(await applyListQuery(select(dbs[0]!), list), list)
			;[page, next] = [items, meta.nextCursor]
		}
		ids.push(...page.map((row) => row["id"] as string))
		if (next === null) return ids
		cursor = next
	}
	return ids
}
