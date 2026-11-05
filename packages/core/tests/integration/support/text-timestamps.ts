/**
 * B2-3 of area B on SQLite: a non-STRICT INTEGER column takes TEXT, as a `CURRENT_TIMESTAMP` default
 * or a raw `datetime()` writer stores it, and drizzle reads a `timestamp` or `timestamp_ms` column's
 * TEXT as a Date, valid for a date-like text and invalid for any other. SQLite orders every TEXT
 * after every number, so a cursor bound as a number never passes a TEXT row: the table list looped
 * ascending and skipped descending. A list that reads the key back from the anchor row binds a TEXT
 * row's own text; one that binds as read (no anchor, a joined key, a merged list) carries no text,
 * so it answers a 500 naming the key, never a repeated or skipped row. Each column holds a REAL, an
 * integer, a date-like TEXT, a word, a TEXT holding a comma and twice one TEXT past the cursor's cap,
 * in that order ascending, so a walk resumes past a deleted cursor row both ways, numbers below it and
 * a tie inside the TEXT range after it; ids are out of key order. Each engine's suite runs it on its
 * own driver, and on two shards for the merged list; `listOptions` reads the table through drizzle's
 * relational API.
 */
import { defineRelations, eq } from "drizzle-orm"
import { integer, type SQLiteAsyncDatabase, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { paginateMerged } from "../../../src/query/merged.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import type { ListQueryResult } from "../../../src/query/sqlite/build-list-query-types.ts"

const post = sqliteTable("post", {
	id: text("id").primaryKey(),
	m: integer("m", { mode: "timestamp_ms" }),
	s: integer("s", { mode: "timestamp" }),
})
const metric = sqliteTable("metric", {
	m: integer("m", { mode: "timestamp_ms" }),
	post_id: text("post_id"),
	s: integer("s", { mode: "timestamp" }),
})
/** The relations a suite builds its drizzle with, so `listOptions` reads `post` through `findMany` */
export const TEXT_RELATIONS = defineRelations({ post })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["m", "s"] })

/* past the cap a cursor holds (MAX_CURSOR_LENGTH), so its cursor carries it by reference */
const LONG_TEXT = "replace(hex(zeroblob(4500)), '0', 'z')"

/*
 * seconds: 1000.5 < 2000 < '1970-…' < 'a-text' < 'b,text' (a comma, which no join may split) < 9000
 * z's, twice (f before g by id); milliseconds: 1500.0 (a whole REAL) < 2000000 < the same texts
 */
const ROWS = [
	"('c', 1000.5, 1500.0)",
	"('a', 2000, 2000000)",
	"('d', '1970-01-01T00:00:01Z', '1970-01-01T00:00:01Z')",
	"('e', 'a-text', 'a-text')",
	"('h', 'b,text', 'b,text')",
	`('f', ${LONG_TEXT}, ${LONG_TEXT})`,
	`('g', ${LONG_TEXT}, ${LONG_TEXT})`,
] as const

/** The statements that seed one database with every one of `rows`, or one shard of two with its half */
const seedOf =
	(rows: readonly string[]) =>
	(shard?: 0 | 1): string[] => [
		"CREATE TABLE post (id TEXT PRIMARY KEY, s INTEGER, m INTEGER)",
		"CREATE TABLE metric (post_id TEXT, s INTEGER, m INTEGER)",
		`INSERT INTO post VALUES ${(shard === undefined ? rows : rows.filter((_, i) => i % 2 === shard)).join(", ")}`,
		"INSERT INTO metric SELECT id, s, m FROM post",
	]

/** The statements that seed one database with every row, or one shard of two with its half */
export const TEXT_SEED = seedOf(ROWS)

/*
 * B2-6 of area B: milliseconds holding a fraction below one, as a raw writer stores a REAL, which the
 * Date drizzle reads truncates toward zero: -1.5 < -1.25 < 1000.25 < 1000.5 < 1000.75 < 1001, the
 * seconds the same; no TEXT, so every list pages them
 */
const FRACTION_ROWS = [
	"('c', 1000.5, 1000.5)",
	"('f', -1.25, -1.25)",
	"('a', 1001, 1001)",
	"('e', 1000.25, 1000.25)",
	"('b', -1.5, -1.5)",
	"('d', 1000.75, 1000.75)",
] as const

/** The statements that seed a database, or one shard of two, with the fraction rows */
export const FRACTION_SEED = seedOf(FRACTION_ROWS)

/** Every id by either key over the fraction rows */
export const FRACTION_SERVED = {
	asc: ["b", "f", "e", "c", "d", "a"],
	desc: ["a", "d", "c", "e", "f", "b"],
} as const

/** Every id in SQLite's order of either key */
export const TEXT_SERVED = {
	asc: ["c", "a", "d", "e", "h", "f", "g"],
	desc: ["g", "f", "h", "e", "d", "a", "c"],
} as const

export type TextKey = "m" | "s"
export type TextShape = "anchored joined" | "anchored own" | "anchorless" | "listOptions" | "merged" | "table"
type Db = SQLiteAsyncDatabase<any, any>

type Parsed = ReturnType<typeof schema.parse>

/** The list `shape`, any built on one database, builds for `parsed` */
function listOf(shape: Exclude<TextShape, "listOptions" | "merged">, parsed: Parsed): ListQueryResult {
	if (shape === "table") return buildListQuery({ ...SEALED, parsed, table: post })
	const sortColumns = shape === "anchored joined" ? { m: metric.m, s: metric.s } : { m: post.m, s: post.s }
	if (shape === "anchorless") return buildDerivedListQuery({ ...SEALED, idColumn: post.id, parsed, sortColumns })
	return buildDerivedListQuery({ ...SEALED, anchor: { idColumn: post.id, table: post }, parsed, sortColumns })
}

/** One page of the list `shape` builds by `key` for `parsed`, over every shard of `dbs` when merged, and its next cursor */
async function pageOf(
	dbs: readonly Db[],
	{ key, shape }: { key: TextKey; shape: TextShape },
	parsed: Parsed,
): Promise<[Record<string, unknown>[], string | null]> {
	const select = (db: Db) => (extras: object) =>
		db
			.select({ id: post.id, [key]: shape === "anchored joined" ? metric[key] : post[key], ...extras })
			.from(post)
			.innerJoin(metric, eq(metric.post_id, post.id))
	if (shape === "listOptions") {
		const options = queryHelpers.listOptions(parsed, SEALED)
		const relational = dbs[0] as unknown as {
			query: { post: { findMany: (options: never) => Promise<Record<string, unknown>[]> } }
		}
		const [items, meta] = queryHelpers.paginate(await relational.query.post.findMany(options as never), options)
		return [items, meta.nextCursor]
	}
	if (shape === "merged") {
		const list = buildListQuery({ ...SEALED, merged: {}, parsed, table: post })
		const [items, meta] = paginateMerged(await Promise.all(dbs.map((db) => applyListQuery(select(db), list))), list)
		return [items, meta.nextCursor]
	}
	const list = listOf(shape, parsed)
	const [items, meta] = queryHelpers.paginate(await applyListQuery(select(dbs[0]!), list), list)
	return [items, meta.nextCursor]
}

/** The rows of the first page the list of `shape` by `key` serves `direction`, as paginate hands them on */
export async function firstPage(
	dbs: readonly Db[],
	{ direction, key, shape }: { direction: "asc" | "desc"; key: TextKey; shape: TextShape },
): Promise<Record<string, unknown>[]> {
	const [items] = await pageOf(dbs, { key, shape }, schema.parse({ order: `${key}.${direction}` }))
	return items
}

/** `ids`' rows deleted on every shard, from both tables */
async function dropRows(dbs: readonly Db[], ids: readonly string[]): Promise<void> {
	for (const db of dbs)
		for (const id of ids) {
			await db.delete(post).where(eq(post.id, id))
			await db.delete(metric).where(eq(metric.post_id, id))
		}
}

/**
 * Every id the list of `shape` by `key` serves, one a page, by cursor, at most eight pages, deleting
 * each page's rows on every shard before the next when `deleting`; and the error that ended it
 */
export async function servedText(
	dbs: readonly Db[],
	{ deleting, direction, key, shape }: { deleting: boolean; direction: "asc" | "desc"; key: TextKey; shape: TextShape },
): Promise<{ error?: unknown; ids: string[] }> {
	const ids: string[] = []
	let cursor: string | undefined
	try {
		for (let n = 1; n <= 8; n++) {
			const [items, next] = await pageOf(
				dbs,
				{ key, shape },
				{ ...schema.parse({ order: `${key}.${direction}` }), cursor },
			)
			const page = items.map((row) => (row as { id: string }).id)
			ids.push(...page)
			if (deleting) await dropRows(dbs, page)
			if (next === null) return { ids }
			cursor = next
		}
	} catch (error) {
		return { error, ids }
	}
	return { ids }
}

/** Whether `ids` is the start of `order`: no id repeated, none skipped */
export const startsOrder = (ids: readonly string[], order: readonly string[]): boolean =>
	ids.every((id, i) => order[i] === id)
