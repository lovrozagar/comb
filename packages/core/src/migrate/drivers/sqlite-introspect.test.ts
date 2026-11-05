import { describe, expect, it } from "vitest"
import { type LibsqlConnection, libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { getSqliteColumns, getSqliteIndexes, getSqliteTables, introspectSqliteSchema } from "./sqlite-introspect.ts"

/* introspection is SQL sqlite_master answers, so it runs on SQLite */
async function withSchema<T>(ddl: string, read: (conn: LibsqlConnection) => Promise<T>): Promise<T> {
	const conn = libsqlConnection()
	try {
		await conn.client.executeMultiple(ddl)
		return await read(conn)
	} finally {
		await conn.close()
	}
}

const USERS =
	"CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT); CREATE TABLE posts (id TEXT PRIMARY KEY); CREATE INDEX idx_users_email ON users(email);"

describe("introspectSqliteSchema", () => {
	it("returns sorted SQL from sqlite_master", async () => {
		const sql = await withSchema(USERS, introspectSqliteSchema)
		/* tables come before indexes */
		expect(sql.indexOf("CREATE TABLE")).toBeLessThan(sql.indexOf("CREATE INDEX"))
		expect(sql.endsWith(";")).toBe(true)
	})

	it("leaves out a spellfix1 index's shadow table and a view, keeping a plain trigger", async () => {
		const sql = await withSchema(
			"CREATE TABLE t (a); CREATE TABLE words_vocab (x); CREATE VIEW v AS SELECT 1; CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN SELECT 1; END;",
			introspectSqliteSchema,
		)
		expect(sql).toContain("words_vocab")
		expect(sql).toContain("t_ai")
		expect(sql).not.toContain("VIEW")
	})
})

describe("introspectSqliteSchema — FTS5 objects", () => {
	it("leaves out the virtual table, its shadow tables and the triggers writing into it, keeping others", async () => {
		const ddl = `CREATE TABLE p (id INTEGER PRIMARY KEY, a TEXT);
CREATE VIRTUAL TABLE p_fts USING fts5(a, content='p', content_rowid='id');
CREATE TRIGGER p_fts_ai AFTER INSERT ON p BEGIN INSERT INTO p_fts(rowid, a) VALUES (new.id, new.a); END;
CREATE TRIGGER p_log AFTER INSERT ON p BEGIN SELECT 1; END;`
		const sql = await withSchema(ddl, introspectSqliteSchema)
		expect(sql).toContain("p_log")
		expect(sql).not.toMatch(/p_fts/)
		expect((await withSchema(ddl, getSqliteTables)).sort()).toEqual(["p"])
	})
})

describe("getSqliteTables", () => {
	it("returns table names from sqlite_master", async () => {
		expect((await withSchema(USERS, getSqliteTables)).sort()).toEqual(["posts", "users"])
	})
})

describe("getSqliteColumns", () => {
	it("returns column names from PRAGMA table_info, for a table name that needs quoting too", async () => {
		expect(await withSchema(USERS, (conn) => getSqliteColumns(conn, "users"))).toEqual(["id", "email"])
		expect(
			await withSchema('CREATE TABLE "odd ""name" (a, b);', (conn) => getSqliteColumns(conn, 'odd "name')),
		).toEqual(["a", "b"])
	})
})

describe("getSqliteIndexes", () => {
	it("returns index names from sqlite_master", async () => {
		expect(await withSchema(USERS, getSqliteIndexes)).toEqual(["idx_users_email"])
	})
})
