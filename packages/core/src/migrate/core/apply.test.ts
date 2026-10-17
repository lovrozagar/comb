import { describe, expect, it, vi } from "vitest"
import {
	applyMigration,
	checkMigrationHash,
	cleanupBackupTables,
	createBackupTables,
	ensureMigrationsTable,
	recordMigrationHash,
	verifySchema,
} from "./apply.ts"
import type { Connection, ExtractedSchema, ParsedMigration, QueryResult } from "../types.ts"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { generateMigrationHash, legacyMigrationHash, migrationHashes } from "./parse.ts"

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

describe("checkMigrationHash — hashes recorded before 0.5.0 (S-13)", () => {
	it("finds a migration recorded under its legacy hash, so it is not applied again", async () => {
		const sql = "INSERT INTO t VALUES ('a -- b');\n-- applied before 0.5.0"
		const conn = libsqlConnection()
		try {
			await ensureMigrationsTable(conn)
			await recordMigrationHash(conn, legacyMigrationHash(sql))
			expect(generateMigrationHash(sql)).not.toBe(legacyMigrationHash(sql))
			expect(await checkMigrationHash(conn, migrationHashes(sql))).toBe(true)
			expect(await checkMigrationHash(conn, generateMigrationHash(sql))).toBe(false)
		} finally {
			await conn.close()
		}
	})
})

describe("verifySchema — when the database fails", () => {
	it("throws the failure instead of reading it as a schema that needs applying", async () => {
		const conn = mockConnection({ execute: vi.fn(() => Promise.reject(new Error("database is locked"))) })
		await expect(verifySchema(conn, makeSchema(new Map([["post", ["id"]]]), ["idx_post"]))).rejects.toThrow(
			"database is locked",
		)
	})
})

describe("cleanupBackupTables — on SQLite", () => {
	it("drops only backup tables older than the cutoff, and nothing a LIKE pattern would have caught", async () => {
		const conn = libsqlConnection()
		try {
			const now = Date.now()
			await conn.client.executeMultiple(
				`CREATE TABLE "_backup_post_1" (x); CREATE TABLE "_backup_post_${now}" (x); CREATE TABLE "_backup_nostamp" (x); CREATE TABLE "xbackup_post_1" (x);`,
			)
			expect(await cleanupBackupTables(conn, 1000)).toBe(1)
			const { rows } = await conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			expect(rows.map((row) => row[0])).toEqual(["_backup_nostamp", `_backup_post_${now}`, "xbackup_post_1"])
		} finally {
			await conn.close()
		}
	})
})

describe("verifySchema — on SQLite", () => {
	it("finds the tables, columns and indexes a migration created, and names what is missing", async () => {
		const conn = libsqlConnection()
		try {
			await conn.client.executeMultiple(
				'CREATE TABLE "post" (id TEXT, title TEXT); CREATE INDEX idx_post_title ON post(title);',
			)
			const present = await verifySchema(conn, makeSchema(new Map([["post", ["id", "title"]]]), ["idx_post_title"]))
			expect(present).toEqual({ errors: [], found: 1, ok: true })
			const absent = await verifySchema(
				conn,
				makeSchema(new Map([["post", ["id", "body"]]]), ["idx_post_title", "idx_gone"]),
			)
			expect(absent.errors).toEqual(["post missing columns: body", "Missing indexes: idx_gone"])
		} finally {
			await conn.close()
		}
	})
})
