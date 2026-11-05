/**
 * AB3-2 of area B on SQLite: drizzle's `integer({ mode: "boolean" })` reads every value but 1 as
 * false, and a non-STRICT INTEGER column holds -1, 2, a REAL, a TEXT or a blob a raw writer or a
 * migration stored. A cursor bound by the value read binds 0 for each, so the table list served
 * `a b c b c`… ascending without end and skipped rows descending. A list that reads the key back
 * from the anchor row binds the row's stored value; one that binds it as read (no anchor, a joined
 * key, a merged list) answers a 500 naming the key, never a repeated or skipped row. Each engine's
 * suite runs it on its own driver, and on two shards for the merged list; `listOptions` reads the
 * table through drizzle's relational API.
 */
import { defineRelations, eq } from "drizzle-orm"
import { integer, type SQLiteAsyncDatabase, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { paginateMerged } from "../../../src/query/merged.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"

const post = sqliteTable("post", { b: integer("b", { mode: "boolean" }), id: text("id").primaryKey() })
const metric = sqliteTable("metric", { b: integer("b", { mode: "boolean" }), post_id: text("post_id") })
/** The relations a suite builds its drizzle with, so `listOptions` reads `post` through `findMany` */
export const BOOLEAN_RELATIONS = defineRelations({ post })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["b"] })

/* -Infinity < -1 < 0 < 1 < 1.5 < 2, twice (c before d by id) < 2^53 + 1 < Infinity < 'yes' < x'01', SQLite's
   order; ids out of key order */
const ROWS = [
	"('c', 2)",
	"('a', 0)",
	"('g', 'yes')",
	"('e', -1)",
	"('h', x'01')",
	"('b', 1)",
	"('f', 1.5)",
	"('d', 2)",
	"('i', 9007199254740993)",
	"('j', 9e999)",
	"('k', -9e999)",
] as const

/** The statements that seed one database with every row, or one shard of two with its half */
export const BOOLEAN_SEED = (shard?: 0 | 1): string[] => [
	"CREATE TABLE post (id TEXT PRIMARY KEY, b INTEGER)",
	"CREATE TABLE metric (post_id TEXT, b INTEGER)",
	`INSERT INTO post VALUES ${(shard === undefined ? ROWS : ROWS.filter((_, i) => i % 2 === shard)).join(", ")}`,
	"INSERT INTO metric SELECT id, b FROM post",
]

/** Every id in SQLite's order of the key */
export const BOOLEAN_SERVED = {
	asc: ["k", "e", "a", "b", "f", "c", "d", "i", "j", "g", "h"],
	desc: ["h", "g", "j", "i", "d", "c", "f", "b", "a", "e", "k"],
} as const

export type BooleanShape = "anchored joined" | "anchored own" | "anchorless" | "listOptions" | "merged" | "table"
type Db = SQLiteAsyncDatabase<any, any>
type Parsed = ReturnType<typeof schema.parse>

const idsOf = (items: readonly Record<string, unknown>[]) => items.map((row) => row["id"] as string)

/** Delete the rows `page` names from every shard of `dbs` */
async function deleteRows(dbs: readonly Db[], page: readonly string[]) {
	for (const db of dbs)
		for (const id of page) {
			await db.delete(post).where(eq(post.id, id))
			await db.delete(metric).where(eq(metric.post_id, id))
		}
}

/** One page of the list `shape` builds for `parsed`, over every shard of `dbs` when merged, and its next cursor */
async function pageOf(dbs: readonly Db[], shape: BooleanShape, parsed: Parsed): Promise<[string[], string | null]> {
	const select = (db: Db) => (extras: object) =>
		db
			.select({ b: shape === "anchored joined" ? metric.b : post.b, id: post.id, ...extras })
			.from(post)
			.innerJoin(metric, eq(metric.post_id, post.id))
	if (shape === "listOptions") {
		const options = queryHelpers.listOptions(parsed, SEALED)
		const relational = dbs[0] as unknown as {
			query: { post: { findMany: (options: never) => Promise<Record<string, unknown>[]> } }
		}
		const [items, meta] = queryHelpers.paginate(await relational.query.post.findMany(options as never), options)
		return [idsOf(items), meta.nextCursor]
	}
	if (shape === "merged") {
		const list = buildListQuery({ ...SEALED, merged: {}, parsed, table: post })
		const [items, meta] = paginateMerged(await Promise.all(dbs.map((db) => applyListQuery(select(db), list))), list)
		return [idsOf(items), meta.nextCursor]
	}
	const anchor = { idColumn: post.id, table: post }
	const list =
		shape === "table"
			? buildListQuery({ ...SEALED, parsed, table: post })
			: shape === "anchorless"
				? buildDerivedListQuery({ ...SEALED, idColumn: post.id, parsed, sortColumns: { b: post.b } })
				: buildDerivedListQuery({
						...SEALED,
						anchor,
						parsed,
						sortColumns: { b: shape === "anchored joined" ? metric.b : post.b },
					})
	const [items, meta] = queryHelpers.paginate(await applyListQuery(select(dbs[0]!), list), list)
	return [idsOf(items), meta.nextCursor]
}

/**
 * Every id the list of `shape` serves `direction`, one a page, by cursor, at most fourteen pages,
 * deleting each page's rows on every shard before the next when `deleting`; and the error that ended it
 */
export async function servedBooleans(
	dbs: readonly Db[],
	{ deleting, direction, shape }: { deleting: boolean; direction: "asc" | "desc"; shape: BooleanShape },
): Promise<{ error?: unknown; ids: string[] }> {
	const ids: string[] = []
	let cursor: string | undefined
	try {
		for (let n = 1; n <= 14; n++) {
			const [page, next] = await pageOf(dbs, shape, { ...schema.parse({ order: `b.${direction}` }), cursor })
			ids.push(...page)
			if (deleting) await deleteRows(dbs, page)
			if (next === null) return { ids }
			cursor = next
		}
	} catch (error) {
		return { error, ids }
	}
	return { ids }
}

export const BOOLEAN_WALKS = [false, true].flatMap((deleting) =>
	(["asc", "desc"] as const).map((direction) => ({ deleting, direction })),
)
