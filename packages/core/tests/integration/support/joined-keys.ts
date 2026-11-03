/**
 * QL1 and QL2 of r22b on SQLite: a derived list anchored on `post` and sorted by a joined table's
 * column, and one with no anchor, over keys whose cursor value is not the stored value: an integer
 * past 2^53 the driver reads as a number, a REAL ±Infinity (D1 reads it as null), and a seconds-mode
 * timestamp whose stored seconds carry a fraction below the millisecond. Ids are out of key order,
 * so a predicate that falls to the id shows. Each engine's suite runs it on its own driver.
 */
import { eq } from "drizzle-orm"
import { integer, real, type SQLiteAsyncDatabase, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { buildDerivedListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

const post = sqliteTable("post", {
	at: integer("at", { mode: "timestamp" }),
	big: integer("big"),
	id: text("id").primaryKey(),
	x: real("x"),
})
const metric = sqliteTable("metric", {
	at: integer("at", { mode: "timestamp" }),
	big: integer("big"),
	post_id: text("post_id"),
	x: real("x"),
})

/* 2^60 + 200, + 210 and + 250 read as one double, 2^60 + 256; the stored seconds differ below the millisecond */
export const SEED: readonly string[] = [
	"CREATE TABLE post (id TEXT PRIMARY KEY, big INTEGER, x REAL, at REAL)",
	"CREATE TABLE metric (post_id TEXT, big INTEGER, x REAL, at REAL)",
	"INSERT INTO post VALUES ('d', 1152921504606847176, -9e999, 100.0001), ('a', 1152921504606847186, 1, 100.0004), ('c', 1152921504606847226, 2, 100.0007), ('b', 1152921504606847500, 9e999, 100.002)",
	"INSERT INTO metric SELECT id, big, x, at FROM post",
]

/** Every id, ascending and descending */
export const SERVED = { asc: ["d", "a", "c", "b"], desc: ["b", "c", "a", "d"] } as const

export type JoinedKey = "at" | "big" | "x"
export type ListShape = "anchored own" | "anchored joined" | "anchorless"

/** Every id the list of `shape` by `key` serves, one a page, by cursor, at most eight pages */
export async function servedBy(
	db: SQLiteAsyncDatabase<any, any>,
	{ direction, key, shape }: { direction: "asc" | "desc"; key: JoinedKey; shape: ListShape },
): Promise<string[]> {
	const column = shape === "anchored joined" ? metric[key] : post[key]
	const ids: string[] = []
	let cursor: string | undefined
	for (let n = 1; n <= 8; n++) {
		const parsed = { cursor, limit: 1, parsedSort: [{ direction, field: "k" }] }
		const built =
			shape === "anchorless"
				? buildDerivedListQuery({ ...SEALED, idColumn: post.id, parsed, sortColumns: { k: column } })
				: buildDerivedListQuery({
						...SEALED,
						anchor: { idColumn: post.id, table: post },
						parsed,
						sortColumns: { k: column },
					})
		const query = db
			.select({ id: post.id, k: column, ...built.extras })
			.from(post)
			.innerJoin(metric, eq(metric.post_id, post.id))
			.$dynamic()
		const rows = await (built.where === undefined ? query : query.where(built.where))
			.orderBy(...built.orderBy)
			.limit(built.limit)
		const [items, meta] = queryHelpers.paginate(rows, built)
		ids.push(...items.map((row) => row.id))
		if (meta.nextCursor === null) return ids
		cursor = meta.nextCursor
	}
	return ids
}
