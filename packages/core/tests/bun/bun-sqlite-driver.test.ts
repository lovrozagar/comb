/// <reference types="bun-types" />
/**
 * The bun:sqlite migration driver on bun:sqlite itself. Its sibling test under vitest runs the
 * same driver on Node's SQLite with bun's Database methods added; this file proves bun's own.
 */
import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureMigrationsTable } from "../../src/migrate/core/apply.ts"
import { createBunSqliteProvider } from "../../src/migrate/drivers/bun-sqlite.ts"

const DB = { migrationsDir: "m", name: "local", provider: { path: ":memory:", type: "bun-sqlite" as const } }

describe("createBunSqliteProvider on bun:sqlite", () => {
	it("runs a batch with and without parameters and reads rows by column", async () => {
		const conn = await createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" }).connect(DB)
		await conn.batch([{ sql: "CREATE TABLE t (a, b)" }, { params: [1, "x"], sql: "INSERT INTO t VALUES (?, ?)" }])
		expect(await conn.execute("SELECT a, b FROM t WHERE a = ?", [1])).toEqual({ columns: ["a", "b"], rows: [[1, "x"]] })
		expect(await conn.execute("SELECT a FROM t WHERE a = 9")).toEqual({ columns: [], rows: [] })
		await conn.close()
	})

	it("applies none of a batch when one statement fails, and rejects instead of throwing", async () => {
		const conn = await createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" }).connect(DB)
		await conn.batch([{ sql: "CREATE TABLE t (a)" }])
		const failing = conn.batch([{ sql: "INSERT INTO t VALUES (1)" }, { sql: "INSERT INTO missing VALUES (2)" }])
		await expect(failing).rejects.toThrow(/missing/)
		expect((await conn.execute("SELECT count(*) AS n FROM t")).rows).toEqual([[0]])
		await conn.close()
	})
})

describe("createBunSqliteProvider with foreign keys on, as the proof run rates a file (r18 S1)", () => {
	it("cascades a parent's delete into its children, and refuses a child with no parent", async () => {
		const conn = await createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" }).connect(DB)
		await conn.batch([
			{ sql: "CREATE TABLE parent (id INTEGER PRIMARY KEY)" },
			{
				sql: "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent (id) ON DELETE CASCADE)",
			},
			{ sql: "INSERT INTO parent VALUES (1), (2)" },
			{ sql: "INSERT INTO child VALUES (10, 1), (11, 1), (12, 2)" },
		])
		await conn.batch([{ sql: "DELETE FROM parent WHERE id = 1" }])
		expect((await conn.execute("SELECT id, parent_id FROM child ORDER BY id")).rows).toEqual([[12, 2]])
		await expect(conn.batch([{ sql: "INSERT INTO child VALUES (13, 9)" }])).rejects.toThrow(/FOREIGN KEY/)
		expect((await conn.execute("PRAGMA foreign_key_check")).rows).toEqual([])
		await conn.close()
	})
})

describe("createBunSqliteProvider read-only, as check and status open it (M10)", () => {
	it("refuses a missing file without creating it, and refuses a write to an existing one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-bun-ro-"))
		try {
			const path = join(dir, "core.db")
			const provider = createBunSqliteProvider({ path, type: "bun-sqlite" })
			await expect(provider.connect({ ...DB, readonly: true })).rejects.toThrow(
				"does not exist; check and status open a database read-only, and create none",
			)
			expect(existsSync(path)).toBe(false)
			const writer = await provider.connect(DB)
			await writer.batch([{ sql: "CREATE TABLE keep (x)" }])
			await writer.close()
			const reader = await provider.connect({ ...DB, readonly: true })
			expect((await reader.execute("SELECT name FROM sqlite_master")).rows).toEqual([["keep"]])
			await expect(reader.batch([{ sql: "CREATE TABLE more (x)" }])).rejects.toThrow(/readonly/)
			await reader.close()
			const memory = await createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" }).connect({
				...DB,
				readonly: true,
			})
			await memory.close()
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

describe("ensureMigrationsTable on bun:sqlite, which names no columns for an empty result (M10)", () => {
	it("adds the name column to a history from before 0.11 once, however often it runs", async () => {
		const conn = await createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" }).connect(DB)
		await conn.execute(
			"CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)",
		)
		await ensureMigrationsTable(conn)
		await ensureMigrationsTable(conn)
		const { rows } = await conn.execute("SELECT name FROM pragma_table_info('__drizzle_migrations') ORDER BY cid")
		expect(rows).toEqual([["id"], ["hash"], ["created_at"], ["name"]])
		await conn.close()
	})
})
