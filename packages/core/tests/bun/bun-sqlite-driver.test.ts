/// <reference types="bun-types" />
/**
 * The bun:sqlite migration driver on bun:sqlite itself. Its sibling test under vitest runs the
 * same driver on Node's SQLite with bun's Database methods added; this file proves bun's own.
 */
import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
