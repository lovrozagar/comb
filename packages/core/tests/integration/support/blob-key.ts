/**
 * B2-5 and B2-12 of area B on SQLite: a list sorted by an expression over a blob, which no buffer-mode
 * column maps, reads its key as each driver reads a blob: bun:sqlite as a Uint8Array, which the next
 * page refused as `invalid_cursor` (a 400), libsql as an ArrayBuffer and D1 as an array of its bytes,
 * which the mint refused as a 500. Blobs compare byte by byte, the shorter first when one begins the
 * other: 00 < 01 < 0101 < ff. Ids are out of key order. Each engine's suite runs it on its own driver.
 */
import { sql } from "drizzle-orm"
import { blob, type SQLiteAsyncDatabase, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery } from "../../../src/query/sqlite/build-list-query.ts"

const bytes = sqliteTable("blob_key", { id: text("id").primaryKey(), k: blob("k") })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["k"] })
const key = sql`${bytes.k}`

/** The statements that seed a database with every row */
export const BLOB_SEED = [
	"CREATE TABLE blob_key (id TEXT PRIMARY KEY, k BLOB)",
	"INSERT INTO blob_key VALUES ('d', x'00'), ('a', x'01'), ('c', x'0101'), ('b', x'ff')",
] as const

/** Every id by `k`, ascending and descending */
export const BLOB_SERVED = { asc: ["d", "a", "c", "b"], desc: ["b", "c", "a", "d"] } as const

/** Every id the list `shape` over `db` serves by the expression over `k`, one a page, at most eight pages */
export async function servedBlob(
	db: SQLiteAsyncDatabase<any, any>,
	{ direction, shape }: { direction: "asc" | "desc"; shape: "anchored" | "anchorless" },
): Promise<string[]> {
	const ids: string[] = []
	let cursor: string | undefined
	for (let n = 1; n <= 8; n++) {
		const parsed = { ...schema.parse({ order: `k.${direction}` }), cursor }
		const list = buildDerivedListQuery({
			...SEALED,
			...(shape === "anchored" ? { anchor: { idColumn: bytes.id, table: bytes } } : { idColumn: bytes.id }),
			parsed,
			sortColumns: { k: key },
		})
		const rows = await applyListQuery((extras) => db.select({ id: bytes.id, k: key, ...extras }).from(bytes), list)
		const [items, meta] = queryHelpers.paginate(rows, list)
		ids.push(...items.map((row) => row["id"] as string))
		if (meta.nextCursor === null) return ids
		cursor = meta.nextCursor
	}
	return ids
}
