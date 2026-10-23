/// <reference types="bun-types" />
/**
 * The proof run under Bun, where its in-memory copy is bun:sqlite (memory.ts picks it): the target
 * is a bun:sqlite database too, read only for its schema.
 */
import { describe, expect, it } from "bun:test"
import { FILE, START, stateOf } from "../../src/migrate/__fixtures__/apply-parity.ts"
import { applyToCopy } from "../../src/migrate/core/proof-engine.ts"
import { provePending } from "../../src/migrate/core/proof-run.ts"
import { splitSqlStatements } from "../../src/migrate/core/sql-scan.ts"
import { createBunSqliteProvider, openBunMemory } from "../../src/migrate/drivers/bun-sqlite.ts"

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

describe("the proof's engine pass on bun:sqlite", () => {
	it("leaves the copy as the target's own apply leaves a bun:sqlite target", async () => {
		const target = await createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" }).connect(DB)
		await target.batch(splitSqlStatements(START).map((sql) => ({ sql })))
		await target.batch(splitSqlStatements(FILE).map((sql) => ({ sql })))
		const copy = await openBunMemory()
		copy.exec(START)
		expect(applyToCopy(copy, FILE).error).toBeUndefined()
		const read = async (sql: string) => {
			const { columns, rows } = await target.execute(sql)
			return rows.map((row) => Object.fromEntries(columns.map((column, i) => [column, row[i]])))
		}
		expect(await stateOf(async (sql) => copy.all(sql))).toEqual(await stateOf(read))
		copy.close()
		await target.close()
	})
})
