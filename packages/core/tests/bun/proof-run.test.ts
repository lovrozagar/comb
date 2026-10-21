/// <reference types="bun-types" />
/**
 * The proof run under Bun, where its in-memory copy is bun:sqlite (memory.ts picks it): the target
 * is a bun:sqlite database too, read only for its schema.
 */
import { describe, expect, it } from "bun:test"
import { provePending } from "../../src/migrate/core/proof-run.ts"
import { createBunSqliteProvider } from "../../src/migrate/drivers/bun-sqlite.ts"

const DB = { migrationsDir: "m", name: "local", provider: { path: ":memory:", type: "bun-sqlite" as const } }

describe("provePending on bun:sqlite", () => {
	it("catches a copy that drops rows, and proves a lossless one clean", async () => {
		const conn = await createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" }).connect(DB)
		await conn.batch([{ sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)" }])
		const copy = (where: string) =>
			`CREATE TABLE new_users (id INTEGER PRIMARY KEY, email TEXT);\nINSERT INTO new_users (id, email) SELECT id, email FROM users${where};\nDROP TABLE users;\nALTER TABLE new_users RENAME TO users;`
		const proofs = await provePending(conn, [
			{ name: "1_clean.sql", sql: copy("") },
			{ name: "2_filtered.sql", sql: copy(" WHERE id > 7") },
		])
		expect(proofs.get("1_clean.sql")).toEqual({ cautious: [], unproven: [], unsafe: [] })
		expect(proofs.get("2_filtered.sql")?.unsafe.join("\n")).toContain("loses")
		await conn.close()
	})
})
