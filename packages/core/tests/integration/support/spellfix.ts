/**
 * K1 of r19: buildFtsWhereWithSpellfix on a real drizzle database with no spellfix1 extension, as D1,
 * stock bun:sqlite and libsql are. drizzle wraps a failed query as DrizzleQueryError, so SQLite's own
 * words are only on its cause. No test framework is imported, so vitest and bun:test share it.
 */
import { type SQL, sql } from "drizzle-orm"
import { integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { buildFtsWhereWithSpellfix } from "../../../src/query/sqlite/search.ts"

export const item = sqliteTable("item", { id: integer("id").primaryKey(), title: text("title").notNull() })

/* an FTS5 table over item, whose spellfix vocabulary table cannot exist without the extension */
export const SEED = [
	"CREATE TABLE item (id INTEGER PRIMARY KEY, title TEXT NOT NULL)",
	"INSERT INTO item VALUES (1, 'hello world'), (2, 'other')",
	"CREATE VIRTUAL TABLE item_fts USING fts5(title, content='item', content_rowid='id')",
	"INSERT INTO item_fts(item_fts) VALUES ('rebuild')",
]

/** A drizzle database as buildFtsWhereWithSpellfix and the search read it */
type Db = {
	$client?: unknown
	all(query: ReturnType<typeof sql>): Promise<unknown[]> | unknown[]
}

/* drizzle's SQLite dialect, which compiles a query for its text */
const dialect = new (SQLiteDialect as unknown as new () => { sqlToQuery: (query: SQL) => { sql: string } })()

/**
 * The spellfix1 probes run through each wrapper `wrap` makes, as a Worker or a server makes one per
 * request (Q4 of r20, Q3 of r21): `wrap` hands back a counted database over the same client
 */
export function probes(): { count: number; wrap: (db: Db) => Db } {
	const counted = {
		count: 0,
		wrap: (db: Db): Db => ({
			$client: db.$client,
			all: (query) => {
				if (dialect.sqlToQuery(query).sql.includes("editdist3('a', 'b')")) counted.count++
				return db.all(query)
			},
		}),
	}
	return counted
}

/** The ids `query` finds through buildFtsWhereWithSpellfix, spellfix asked of `spellfixTable` */
export async function searched(db: Db, query: string, spellfixTable = "item_spellfix"): Promise<number[]> {
	const where = await buildFtsWhereWithSpellfix(
		db as never,
		{ ftsTable: "item_fts", spellfixTable, table: item },
		query,
	)
	const rows = (await db.all(sql`SELECT ${item.id} AS id FROM ${item} WHERE ${where} ORDER BY ${item.id}`)) as Array<{
		id: number
	}>
	return rows.map((row) => Number(row.id))
}
