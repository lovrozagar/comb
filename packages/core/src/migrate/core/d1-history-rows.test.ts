import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakeD1, localD1, wranglerBin } from "../../cli/__fixtures__/d1.ts"
import { createD1Provider } from "../drivers/d1.ts"
import type { D1Target, ReadConfig } from "./d1-binding.ts"
import { hashStatements, historyTable, intentStatements, readHistory, vouched } from "./d1-history-rows.ts"
import { foldedMigrationHash, generateMigrationHash, legacyMigrationHash, SPACES_KEPT_SINCE } from "./parse.ts"

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
		wrangler: wranglerBin(),
		wranglerConfig: join(dir, "wrangler.toml"),
	}
}

describe("readHistory", () => {
	it("reads a database with none of the history tables as nothing applied, recorded, intended or copied", async () => {
		expect(readHistory(read, await target(), "d1_migrations")).toEqual({
			applied: new Set(),
			appliedAt: new Map(),
			drizzle: undefined,
			intents: undefined,
			recorded: new Map(),
		})
	})

	it("reads wrangler's names, comb's hashes and intents and the pre-0.8 record, a quote in a name kept", async () => {
		const d1 = await target()
		d1.db.exec(historyTable('my "history"'))
		d1.db.exec(`INSERT INTO "my ""history""" (name, applied_at) VALUES ('1_it''s.sql', '2026-11-01 12:00:00')`)
		d1.db.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER)")
		d1.db.exec("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h0', 1)")
		await d1.conn.batch([
			...hashStatements([{ hash: "h1", name: "1_it's.sql" }]),
			...intentStatements([{ hash: "h2", name: "2_it's.sql" }]),
		])
		expect(readHistory(read, d1, 'my "history"')).toEqual({
			applied: new Set(["1_it's.sql"]),
			appliedAt: new Map([["1_it's.sql", Date.parse("2026-11-01T12:00:00Z")]]),
			drizzle: new Set(["h0"]),
			intents: new Map([["2_it's.sql", "h2"]]),
			recorded: new Map([["1_it's.sql", "h1"]]),
		})
	})
})

/* SL5 of r22 and M44: the hashes a recorded row may hold for a file's text, each only where it could have been written */
describe("vouched", () => {
	const sql = "CREATE TABLE t (a\u00a0b);"
	const before = { appliedAt: SPACES_KEPT_SINCE - 1, drizzle: undefined }

	it("takes the current hash always, and the folded one only from an apply before comb kept the space", () => {
		expect(vouched(sql, generateMigrationHash(sql), { appliedAt: SPACES_KEPT_SINCE + 1, drizzle: undefined })).toBe(
			true,
		)
		expect(vouched(sql, foldedMigrationHash(sql), before)).toBe(true)
		expect(vouched(sql, foldedMigrationHash(sql), { appliedAt: SPACES_KEPT_SINCE, drizzle: undefined })).toBe(false)
	})

	it("takes the pre-0.5.0 hash only where comb's pre-0.8 history holds it", () => {
		const legacy = legacyMigrationHash("SELECT '/* kept */';")
		expect(vouched("SELECT '/* kept */';", legacy, before)).toBe(false)
		expect(vouched("SELECT '/* kept */';", legacy, { ...before, drizzle: new Set([legacy]) })).toBe(true)
		expect(vouched(sql, "other", { ...before, drizzle: new Set(["other"]) })).toBe(false)
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
