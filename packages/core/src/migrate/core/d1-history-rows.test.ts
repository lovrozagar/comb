import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakeD1, localD1 } from "../../cli/__fixtures__/d1.ts"
import { createD1Provider } from "../drivers/d1.ts"
import type { D1Target, ReadConfig } from "./d1-binding.ts"
import { hashStatements, historyTable, readHistory, recordHashes } from "./d1-history-rows.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-d1-rows-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const binding = { binding: "CORE", database_id: "00000000-0000-0000-0000-000000000000" }
const read: ReadConfig = () => ({ d1_databases: [binding] })

async function target(): Promise<D1Target & { db: ReturnType<typeof fakeD1>["db"] }> {
	const run = fakeD1({ dir })
	const config = { databaseName: "core", local: true, type: "d1" as const }
	const conn = await createD1Provider(config, run).connect({ migrationsDir: dir, name: "core", provider: config })
	localD1(dir, binding)
	return {
		conn,
		db: run.db,
		exec: run,
		flags: ["--local"],
		migrationsDir: dir,
		name: "CORE",
		wranglerConfig: join(dir, "wrangler.toml"),
	}
}

describe("readHistory", () => {
	it("reads a database with none of the history tables as nothing applied, recorded or copied", async () => {
		expect(readHistory(read, await target(), "d1_migrations")).toEqual({
			applied: new Set(),
			drizzle: undefined,
			recorded: new Map(),
		})
	})

	it("reads wrangler's names, comb's hashes and the pre-0.8 record, a quote in a name kept", async () => {
		const d1 = await target()
		d1.db.exec(historyTable('my "history"'))
		d1.db.exec(`INSERT INTO "my ""history""" (name) VALUES ('1_it''s.sql')`)
		d1.db.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER)")
		d1.db.exec("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h0', 1)")
		await recordHashes(d1.conn, [{ hash: "h1", name: "1_it's.sql" }])
		expect(readHistory(read, d1, 'my "history"')).toEqual({
			applied: new Set(["1_it's.sql"]),
			drizzle: new Set(["h0"]),
			recorded: new Map([["1_it's.sql", "h1"]]),
		})
	})
})

describe("hashStatements", () => {
	it("makes comb's table before any row, so the hashes can go first in any batch", () => {
		const sql = hashStatements([{ hash: "h", name: "a.sql" }]).map((statement) => statement.sql)
		expect(sql).toEqual([
			"CREATE TABLE IF NOT EXISTS _comb_migration_hashes (name TEXT PRIMARY KEY, hash TEXT NOT NULL)",
			"INSERT OR REPLACE INTO _comb_migration_hashes (name, hash) VALUES ('a.sql', 'h')",
		])
	})
})
