/**
 * AB3-3 of area B on SQLite: readCursor returned the value a list binds for a key it re-types, not
 * the value the row read: a numeric() column's "10" came back as 10n and "1.5" as 1.5, libsql's
 * string-mode integer "5" as 5n, D1's null for a REAL Infinity as Infinity, and a blob expression's
 * bytes in another shape. Two rows hold one key value, a page holds one, and each list kind's next
 * cursor is opened by readCursor and set against the key the served row read. Each engine's suite
 * runs it on its own driver, and on two shards for the merged list.
 */
import { eq, getTableColumns, sql } from "drizzle-orm"
import { blob, integer, numeric, real, type SQLiteAsyncDatabase, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { readCursor } from "../../../src/query/cursor.ts"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { paginateMerged } from "../../../src/query/merged.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"

type Db = SQLiteAsyncDatabase<any, any>

/** The keys a list re-types from what its row read: each one's column, how SQLite declares it, and the literal both rows hold */
export const READ_KEYS = {
	blob: { column: () => blob("k", { mode: "buffer" }), ddl: "BLOB", literal: "x'0102'" },
	integer: { column: () => integer("k"), ddl: "INTEGER", literal: "5" },
	"numeric integer": { column: () => numeric("k"), ddl: "NUMERIC", literal: "10" },
	"numeric real": { column: () => numeric("k"), ddl: "NUMERIC", literal: "1.5" },
	"real infinity": { column: () => real("k"), ddl: "REAL", literal: "9e999" },
} as const

/** One of the keys a list re-types */
export type ReadKey = (typeof READ_KEYS)[keyof typeof READ_KEYS]

export const READ_KINDS = ["table", "anchored own", "anchored joined", "anchorless", "expression", "merged"] as const
export type ReadKind = (typeof READ_KINDS)[number]

const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["k"] })
const parsed = schema.parse({ order: "k.asc" })

/** The statements that make both tables and seed them with a row per id, both on one database */
export const readSeed = (key: ReadKey, ids: readonly string[] = ["a", "b"]): string[] => [
	`CREATE TABLE post (id TEXT PRIMARY KEY, k ${key.ddl})`,
	`CREATE TABLE metric (post_id TEXT, k ${key.ddl})`,
	`INSERT INTO post VALUES ${ids.map((id) => `('${id}', ${key.literal})`).join(", ")}`,
	"INSERT INTO metric SELECT id, k FROM post",
]

/**
 * The key the first page's row read on the list `kind`, over `dbs` (two shards when merged), and the
 * key readCursor opens from that page's next cursor
 */
export async function readBack(
	dbs: readonly Db[],
	key: ReadKey,
	kind: ReadKind,
): Promise<{ back: unknown; read: unknown }> {
	const post = sqliteTable("post", { id: text("id").primaryKey(), k: key.column() })
	const metric = sqliteTable("metric", { k: key.column(), post_id: text("post_id") })
	const sortKey = kind === "anchored joined" ? metric.k : kind === "expression" ? sql`${post.k}` : post.k
	const select = (db: Db) => (extras: object) =>
		db
			.select({ ...getTableColumns(post), k: sortKey, ...extras })
			.from(post)
			.innerJoin(metric, eq(metric.post_id, post.id))
	let page: readonly [Record<string, unknown>[], { nextCursor: string | null }]
	if (kind === "merged") {
		const list = buildListQuery({ ...SEALED, merged: {}, parsed, table: post })
		page = paginateMerged(await Promise.all(dbs.map((db) => applyListQuery(select(db), list))), list)
	} else {
		const sortColumns = { k: sortKey }
		const anchor = { idColumn: post.id, table: post }
		const list =
			kind === "table"
				? buildListQuery({ ...SEALED, parsed, table: post })
				: kind === "anchorless" || kind === "expression"
					? buildDerivedListQuery({ ...SEALED, idColumn: post.id, parsed, sortColumns })
					: buildDerivedListQuery({ ...SEALED, anchor, parsed, sortColumns })
		page = queryHelpers.paginate(await applyListQuery(select(dbs[0]!), list), list)
	}
	const [items, meta] = page
	return { back: readCursor(meta.nextCursor as string, parsed.parsedSort, SEALED).values[0], read: items[0]?.["k"] }
}

/** The key readCursor returns for one a row read: bytes, a Buffer, an ArrayBuffer or D1's array, as a Uint8Array */
export const asCursorReads = (read: unknown): unknown => {
	if (read instanceof ArrayBuffer) return new Uint8Array(read)
	return read instanceof Uint8Array || Array.isArray(read) ? Uint8Array.from(read as ArrayLike<number>) : read
}
