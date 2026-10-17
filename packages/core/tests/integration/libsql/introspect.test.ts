/**
 * SQLite schema introspection on a real database: FTS5 objects (the virtual table, its shadow
 * tables, the triggers that write into it) are left out, and every other object is kept,
 * whatever its name happens to end in.
 */
import { describe, expect, it } from "vitest"
import { getSqliteIndexes, getSqliteTables, introspectSqliteSchema } from "../../../src/migrate/drivers/sqlite.ts"
import { libsqlConnection } from "../support/libsql.ts"

const SCHEMA = `
CREATE TABLE gifts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
CREATE TABLE sqliteish (id INTEGER PRIMARY KEY);
CREATE TABLE xlitestreamy (id INTEGER PRIMARY KEY);
CREATE TABLE post (id INTEGER PRIMARY KEY, title TEXT);
CREATE INDEX gifts_name ON gifts(name);
CREATE TRIGGER gifts_touch AFTER UPDATE ON gifts BEGIN SELECT 1; END;
CREATE VIRTUAL TABLE post_fts USING fts5(title, content='post', content_rowid='id');
CREATE TRIGGER post_fts_ai AFTER INSERT ON post BEGIN INSERT INTO post_fts(rowid, title) VALUES (new.id, new.title); END;
`

describe("introspectSqliteSchema (S-13)", () => {
	it("keeps every table, index and trigger but the FTS ones, whatever their names end in", async () => {
		const conn = libsqlConnection()
		try {
			await conn.client.executeMultiple(SCHEMA)
			const schema = await introspectSqliteSchema(conn)
			for (const kept of ["gifts", "sqliteish", "xlitestreamy", "post", "gifts_name", "gifts_touch"]) {
				expect(schema).toContain(kept)
			}
			expect(schema).not.toMatch(/post_fts/)
			expect(schema).not.toMatch(/sqlite_sequence/)
		} finally {
			await conn.close()
		}
	})

	it("lists tables and indexes, leaving out SQLite's own and the FTS shadow tables", async () => {
		const conn = libsqlConnection()
		try {
			await conn.client.executeMultiple(SCHEMA)
			expect((await getSqliteTables(conn)).sort()).toEqual(["gifts", "post", "sqliteish", "xlitestreamy"])
			expect(await getSqliteIndexes(conn)).toEqual(["gifts_name"])
		} finally {
			await conn.close()
		}
	})
})
