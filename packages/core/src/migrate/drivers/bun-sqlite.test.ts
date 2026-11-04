/**
 * The bun:sqlite driver under vitest, which runs on Node and cannot load bun:sqlite: the module
 * is replaced by Node's own SQLite (__fixtures__/bun-sqlite-node.ts), so the driver's SQL still
 * runs on a real engine. tests/bun/bun-sqlite-driver.test.ts
 * runs the same driver on bun:sqlite itself.
 */
import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bunLocal, createBunSqliteProvider } from "./bun-sqlite.ts"
import { openedWhileStopping } from "../../../tests/support/signals.ts"

vi.mock("bun:sqlite", () => import("../__fixtures__/bun-sqlite-node.ts"))

const DB = { migrationsDir: "m", name: "local", provider: { path: ":memory:", type: "bun-sqlite" as const } }

describe("createBunSqliteProvider", () => {
	/* r22b: a connection is new work, which a stopping run starts none of */
	it("opens the database only once a signal's stop is past", async () => {
		const provider = createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" })
		const { early, value } = await openedWhileStopping(() => provider.connect(DB))
		await value.close()
		expect(early).toBe(false)
	})

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

describe("createBunSqliteProvider read-only, and the proof run's memory database, under the Node stand-in", () => {
	it("refuses a missing file read-only, opens an existing one, and opens memory without it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-bun-vitest-"))
		try {
			const path = join(dir, "core.db")
			const provider = createBunSqliteProvider({ path, type: "bun-sqlite" })
			await expect(provider.connect({ ...DB, readonly: true })).rejects.toThrow("does not exist")
			await (await provider.connect(DB)).close()
			const reader = await provider.connect({ ...DB, readonly: true })
			expect((await reader.execute("SELECT 1 AS one")).rows).toEqual([[1]])
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

	it("opens a private database that runs statements and reads rows", async () => {
		const db = (await bunLocal())(":memory:")
		db.exec("CREATE TABLE t (a TEXT)")
		db.run("INSERT INTO t VALUES (?)", ["007"])
		db.run("INSERT INTO t VALUES ('x')")
		expect(db.all("SELECT a FROM t WHERE a = ?", ["007"])).toEqual([{ a: "007" }])
		expect(db.all("SELECT count(*) AS n FROM t")).toEqual([{ n: 2 }])
		/* the proof's split (proof-split.ts) reads where SQLite ends a statement: a trigger's body whole, up to its ; */
		const trigger = "CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT new.a; END;"
		expect(db.firstStatement(`${trigger}\nINSERT INTO t VALUES ('y')`)).toBe(trigger)
		db.close()
	})
})
