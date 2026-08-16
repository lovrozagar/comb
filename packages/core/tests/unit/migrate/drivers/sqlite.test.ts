import { describe, expect, it } from "vitest"
import {
	createBunSqliteProvider,
	createLibsqlProvider,
	createTursoProvider,
	getSqliteColumns,
	getSqliteIndexes,
	getSqliteTables,
	introspectSqliteSchema,
} from "../../../../src/migrate/drivers/sqlite.ts"
import type { Connection } from "../../../../src/migrate/types.ts"

function mockConn(executeFn: Connection["execute"]): Connection {
	return {
		batch: () => Promise.resolve(),
		close: () => Promise.resolve(),
		dialect: "sqlite",
		execute: executeFn,
	}
}

describe("provider factories", () => {
	it("createTursoProvider returns sqlite dialect", () => {
		const provider = createTursoProvider({
			apiToken: "tok",
			group: "default",
			org: "test",
			type: "turso",
		})
		expect(provider.dialect).toBe("sqlite")
	})

	it("createLibsqlProvider returns sqlite dialect", () => {
		const provider = createLibsqlProvider({ type: "libsql", url: "libsql://localhost" })
		expect(provider.dialect).toBe("sqlite")
	})

	it("createBunSqliteProvider returns sqlite dialect", () => {
		const provider = createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" })
		expect(provider.dialect).toBe("sqlite")
	})
})

describe("introspectSqliteSchema", () => {
	it("returns sorted SQL from sqlite_master", async () => {
		const conn = mockConn(() =>
			Promise.resolve({
				columns: ["type", "sql"],
				rows: [
					["index", "CREATE INDEX idx_email ON users(email)"],
					["table", "CREATE TABLE users (id TEXT PRIMARY KEY)"],
				],
			}),
		)
		const sql = await introspectSqliteSchema(conn)
		/* tables come before indexes */
		expect(sql.indexOf("CREATE TABLE")).toBeLessThan(sql.indexOf("CREATE INDEX"))
	})
})

describe("getSqliteTables", () => {
	it("returns table names from sqlite_master", async () => {
		const conn = mockConn(() =>
			Promise.resolve({
				columns: ["name"],
				rows: [["users"], ["posts"]],
			}),
		)
		const tables = await getSqliteTables(conn)
		expect(tables).toEqual(["users", "posts"])
	})
})

describe("getSqliteColumns", () => {
	it("returns column names from PRAGMA table_info", async () => {
		const conn = mockConn(() =>
			Promise.resolve({
				columns: ["cid", "name", "type"],
				rows: [
					[0, "id", "TEXT"],
					[1, "email", "TEXT"],
				],
			}),
		)
		const columns = await getSqliteColumns(conn, "users")
		expect(columns).toEqual(["id", "email"])
	})
})

describe("getSqliteIndexes", () => {
	it("returns index names from sqlite_master", async () => {
		const conn = mockConn(() =>
			Promise.resolve({
				columns: ["name"],
				rows: [["idx_users_email"]],
			}),
		)
		const indexes = await getSqliteIndexes(conn)
		expect(indexes).toEqual(["idx_users_email"])
	})
})
