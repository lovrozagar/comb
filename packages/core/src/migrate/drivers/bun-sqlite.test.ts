/**
 * The bun:sqlite driver under vitest, which runs on Node and cannot load bun:sqlite: the module
 * is replaced by Node's own SQLite with the three methods bun's Database adds (run, transaction,
 * close), so the driver's SQL still runs on a real engine. tests/bun/bun-sqlite-driver.test.ts
 * runs the same driver on bun:sqlite itself.
 */
import { describe, expect, it, vi } from "vitest"
import { createBunSqliteProvider } from "./bun-sqlite.ts"

vi.mock("bun:sqlite", async () => {
	const { DatabaseSync } = await import("node:sqlite")
	class Database extends DatabaseSync {
		run(sql: string, params: unknown[] = []) {
			return this.prepare(sql).run(...(params as never[]))
		}

		transaction(work: () => void) {
			return () => {
				this.exec("BEGIN")
				try {
					work()
					this.exec("COMMIT")
				} catch (error) {
					this.exec("ROLLBACK")
					throw error
				}
			}
		}
	}
	return { Database }
})

const DB = { migrationsDir: "m", name: "local", provider: { path: ":memory:", type: "bun-sqlite" as const } }

describe("createBunSqliteProvider", () => {
	it("is a sqlite provider that opens the configured path on connect", async () => {
		const provider = createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" })
		expect(provider.dialect).toBe("sqlite")
		const conn = await provider.connect(DB)
		expect(conn.dialect).toBe("sqlite")
		await conn.close()
	})

	it("runs a batch in one transaction, with and without parameters, and reads rows by column", async () => {
		const conn = await createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" }).connect(DB)
		await conn.batch([{ sql: "CREATE TABLE t (a, b)" }, { params: [1, "x"], sql: "INSERT INTO t VALUES (?, ?)" }])
		expect(await conn.execute("SELECT a, b FROM t WHERE a = ?", [1])).toEqual({ columns: ["a", "b"], rows: [[1, "x"]] })
		expect(await conn.execute("SELECT a FROM t WHERE a = 9")).toEqual({ columns: [], rows: [] })
		await conn.close()
	})

	it("applies none of a batch when one statement fails", async () => {
		const conn = await createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" }).connect(DB)
		await conn.batch([{ sql: "CREATE TABLE t (a)" }])
		await expect(
			conn.batch([{ sql: "INSERT INTO t VALUES (1)" }, { sql: "INSERT INTO missing VALUES (2)" }]),
		).rejects.toThrow()
		expect((await conn.execute("SELECT count(*) AS n FROM t")).rows).toEqual([[0]])
		await conn.close()
	})
})
