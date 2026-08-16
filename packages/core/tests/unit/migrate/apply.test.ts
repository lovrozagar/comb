import { describe, expect, it, vi } from "vitest"
import {
	applyMigration,
	checkMigrationHash,
	cleanupBackupTables,
	createBackupTables,
	ensureMigrationsTable,
	recordMigrationHash,
	verifySchema,
} from "../../../src/migrate/core/apply.ts"
import type { Connection, ExtractedSchema, ParsedMigration, QueryResult } from "../../../src/migrate/types.ts"

function mockConnection(overrides: Partial<Connection> = {}): Connection {
	return {
		batch: vi.fn(() => Promise.resolve()),
		close: vi.fn(() => Promise.resolve()),
		dialect: "sqlite",
		execute: vi.fn(() => Promise.resolve({ columns: [], rows: [] })),
		...overrides,
	}
}

function makeSchema(
	tables: Map<string, string[]>,
	indexes: string[] = [],
	droppedTables: string[] = [],
): ExtractedSchema {
	return { droppedTables, indexes, tables }
}

describe("ensureMigrationsTable", () => {
	it("executes CREATE TABLE IF NOT EXISTS", async () => {
		const conn = mockConnection()
		await ensureMigrationsTable(conn)
		expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE IF NOT EXISTS"))
	})
})

describe("checkMigrationHash", () => {
	it("returns true when hash exists", async () => {
		const conn = mockConnection({
			execute: vi.fn(() => Promise.resolve({ columns: ["hash"], rows: [["abc123"]] })),
		})
		expect(await checkMigrationHash(conn, "abc123")).toBe(true)
	})

	it("returns false when hash missing", async () => {
		const conn = mockConnection()
		expect(await checkMigrationHash(conn, "abc123")).toBe(false)
	})
})

describe("recordMigrationHash", () => {
	it("inserts hash with timestamp", async () => {
		const conn = mockConnection()
		await recordMigrationHash(conn, "abc123")
		expect(conn.execute).toHaveBeenCalledWith(
			expect.stringContaining("INSERT INTO __drizzle_migrations"),
			expect.arrayContaining(["abc123"]),
		)
	})
})

describe("verifySchema", () => {
	it("returns ok when schema matches", async () => {
		const schema = makeSchema(new Map())
		const conn = mockConnection()
		const result = await verifySchema(conn, schema)
		expect(result.ok).toBe(true)
		expect(result.errors).toEqual([])
	})

	it("reports missing table", async () => {
		const schema = makeSchema(new Map([["users", ["id", "email"]]]))
		const conn = mockConnection()
		const result = await verifySchema(conn, schema)
		expect(result.ok).toBe(false)
		expect(result.errors[0]).toContain("Missing table: users")
	})

	it("reports missing columns", async () => {
		const schema = makeSchema(new Map([["users", ["id", "email", "missing_col"]]]))
		let callCount = 0
		const conn = mockConnection({
			execute: vi.fn(() => {
				callCount++
				if (callCount === 1) {
					return Promise.resolve({ columns: ["name"], rows: [["users"]] })
				}
				return Promise.resolve({
					columns: ["cid", "name"],
					rows: [
						[0, "id"],
						[1, "email"],
					],
				})
			}),
		})
		const result = await verifySchema(conn, schema)
		expect(result.ok).toBe(false)
		expect(result.errors[0]).toContain("missing_col")
	})

	it("reports missing indexes", async () => {
		const schema = makeSchema(new Map(), ["idx_users_email"])
		const conn = mockConnection()
		const result = await verifySchema(conn, schema)
		expect(result.ok).toBe(false)
		expect(result.errors[0]).toContain("idx_users_email")
	})
})

describe("applyMigration", () => {
	const migration: ParsedMigration = {
		classification: { safety: "safe", unsafeStatements: [] },
		drops: [],
		expected: makeSchema(new Map([["users", []]])),
		filename: "001_init.sql",
		hash: "abc123",
		sql: "CREATE TABLE users (id TEXT PRIMARY KEY)",
		statements: ["CREATE TABLE users (id TEXT PRIMARY KEY)"],
	}

	it("returns already_applied when hash exists and schema ok", async () => {
		const conn = mockConnection({
			execute: vi.fn((sql: string) => {
				if (sql.includes("CREATE TABLE IF NOT EXISTS")) return Promise.resolve({ columns: [], rows: [] })
				if (sql.includes("SELECT hash")) return Promise.resolve({ columns: ["hash"], rows: [["abc123"]] })
				if (sql.includes("sqlite_master") && sql.includes("type='table'"))
					return Promise.resolve({ columns: ["name"], rows: [["users"]] })
				return Promise.resolve({ columns: [], rows: [] })
			}),
		})
		const result = await applyMigration(conn, "test", migration)
		expect(result.status).toBe("already_applied")
	})

	it("repairs when schema ok but hash missing", async () => {
		const conn = mockConnection({
			execute: vi.fn((sql: string) => {
				if (sql.includes("CREATE TABLE IF NOT EXISTS")) return Promise.resolve({ columns: [], rows: [] })
				if (sql.includes("SELECT hash")) return Promise.resolve({ columns: ["hash"], rows: [] })
				if (sql.includes("sqlite_master") && sql.includes("type='table'"))
					return Promise.resolve({ columns: ["name"], rows: [["users"]] })
				if (sql.includes("INSERT INTO __drizzle")) return Promise.resolve({ columns: [], rows: [] })
				return Promise.resolve({ columns: [], rows: [] })
			}),
		})
		const result = await applyMigration(conn, "test", migration)
		expect(result.status).toBe("repaired")
	})
})

describe("createBackupTables", () => {
	it("creates backup for existing tables", async () => {
		const conn = mockConnection({
			execute: vi.fn((sql: string) => {
				if (sql.includes("sqlite_master")) {
					return Promise.resolve({ columns: ["name"], rows: [["users"]] })
				}
				return Promise.resolve({ columns: [], rows: [] })
			}),
		})
		const result = await createBackupTables(conn, ["users"])
		expect(result.backupSql.length).toBe(1)
		expect(result.restoreSql.length).toBe(2)
		expect(result.backupSql[0]).toContain("_backup_users_")
	})

	it("skips non-existent tables", async () => {
		const conn = mockConnection()
		const result = await createBackupTables(conn, ["nonexistent"])
		expect(result.backupSql).toEqual([])
		expect(result.restoreSql).toEqual([])
	})
})

describe("cleanupBackupTables", () => {
	it("cleans old backup tables", async () => {
		const oldTimestamp = Date.now() - 100000000
		const conn = mockConnection({
			execute: vi.fn((sql: string) => {
				if (sql.includes("sqlite_master")) {
					return Promise.resolve({ columns: ["name"], rows: [[`_backup_users_${oldTimestamp}`]] })
				}
				return Promise.resolve({ columns: [], rows: [] })
			}),
		})
		const cleaned = await cleanupBackupTables(conn, 86400000)
		expect(cleaned).toBe(1)
	})

	it("skips recent backup tables", async () => {
		const recentTimestamp = Date.now()
		const conn = mockConnection({
			execute: vi.fn((sql: string) => {
				if (sql.includes("sqlite_master")) {
					return Promise.resolve({
						columns: ["name"],
						rows: [[`_backup_users_${recentTimestamp}`]],
					})
				}
				return Promise.resolve({ columns: [], rows: [] })
			}),
		})
		const cleaned = await cleanupBackupTables(conn, 86400000)
		expect(cleaned).toBe(0)
	})
})

describe("applyMigration — resolution paths", () => {
	const migration = (over: Partial<ParsedMigration> = {}): ParsedMigration =>
		({
			classification: { safety: "safe", unsafeStatements: [] },
			drops: [],
			expected: makeSchema(new Map([["post", ["id"]]])),
			filename: "0001.sql",
			hash: "abc123",
			sql: "CREATE TABLE post (id TEXT);",
			statements: ["CREATE TABLE post (id TEXT)"],
			...over,
		}) as ParsedMigration

	/**
	 * Routes each query the real code issues:
	 *  - the hash lookup against __drizzle_migrations
	 *  - the table probe against sqlite_master
	 *  - PRAGMA table_info, whose rows are read positionally as r[1]
	 */
	function routedConnection(opts: { hashRecorded: boolean; tableExists: boolean | (() => boolean) }): Connection {
		const exists = () => (typeof opts.tableExists === "function" ? opts.tableExists() : opts.tableExists)
		return mockConnection({
			execute: vi.fn((sql: string): Promise<QueryResult> => {
				if (sql.includes("__drizzle_migrations")) {
					if (sql.toUpperCase().startsWith("SELECT")) {
						return Promise.resolve({ columns: [], rows: opts.hashRecorded ? [["abc123"]] : [] })
					}
					return Promise.resolve({ columns: [], rows: [] })
				}
				if (sql.includes("sqlite_master")) {
					return Promise.resolve({ columns: ["name"], rows: exists() ? [["post"]] : [] })
				}
				if (sql.startsWith("PRAGMA table_info")) {
					return Promise.resolve({ columns: [], rows: [[0, "id", "TEXT"]] })
				}
				return Promise.resolve({ columns: [], rows: [] })
			}),
		})
	}

	it("records the hash without re-running SQL when the schema is already correct", async () => {
		const conn = routedConnection({ hashRecorded: false, tableExists: true })
		const result = await applyMigration(conn, "core", migration())

		expect(result.status).toBe("repaired")
		expect(conn.batch).not.toHaveBeenCalled()
	})

	it("applies the statements and the hash in one batch", async () => {
		/* absent before, present after */
		let applied = false
		const conn = routedConnection({ hashRecorded: false, tableExists: () => applied })
		;(conn.batch as unknown as { mockImplementation: (f: () => Promise<void>) => void }).mockImplementation(() => {
			applied = true
			return Promise.resolve()
		})

		const result = await applyMigration(conn, "core", migration())
		expect(result.status).toBe("success")
		expect(conn.batch).toHaveBeenCalledTimes(1)

		const batched = (conn.batch as unknown as { mock: { calls: Array<[Array<{ sql: string }>]> } }).mock.calls[0]![0]
		expect(batched.at(-1)!.sql).toContain("INSERT INTO __drizzle_migrations")
	})

	it("throws when the schema still does not match after applying", async () => {
		const conn = routedConnection({ hashRecorded: false, tableExists: false })
		await expect(applyMigration(conn, "core", migration())).rejects.toThrow(/Verification failed/)
	})

	it("clears a recorded hash whose schema is missing, then reapplies", async () => {
		let applied = false
		const conn = routedConnection({ hashRecorded: true, tableExists: () => applied })
		;(conn.batch as unknown as { mockImplementation: (f: () => Promise<void>) => void }).mockImplementation(() => {
			applied = true
			return Promise.resolve()
		})

		const result = await applyMigration(conn, "core", migration())
		expect(result.status).toBe("success")

		const executed = (conn.execute as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0] ?? "")
		expect(executed.some((s) => s.toUpperCase().startsWith("DELETE"))).toBe(true)
	})
})

describe("verifySchema — error handling", () => {
	it("reports a probe that threw rather than propagating it", async () => {
		const conn = mockConnection({ execute: vi.fn(() => Promise.reject(new Error("connection lost"))) })
		const result = await verifySchema(conn, makeSchema(new Map([["post", ["id"]]])))

		expect(result.ok).toBe(false)
		expect(result.errors.join(" ")).toContain("connection lost")
	})

	it("names only the columns a table is actually missing", async () => {
		const conn = mockConnection({
			execute: vi.fn((sql: string): Promise<QueryResult> => {
				if (sql.includes("sqlite_master")) return Promise.resolve({ columns: ["name"], rows: [["post"]] })
				return Promise.resolve({ columns: [], rows: [[0, "id", "TEXT"]] })
			}),
		})
		const result = await verifySchema(conn, makeSchema(new Map([["post", ["id", "title"]]])))

		expect(result.ok).toBe(false)
		expect(result.errors.join(" ")).toContain("missing columns: title")
	})

	it("reports a table that does not exist at all", async () => {
		const conn = mockConnection({ execute: vi.fn(() => Promise.resolve({ columns: [], rows: [] })) })
		const result = await verifySchema(conn, makeSchema(new Map([["post", ["id"]]])))

		expect(result.errors.join(" ")).toContain("Missing table: post")
		expect(result.found).toBe(0)
	})
})
