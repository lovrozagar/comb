import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakeD1, localD1, wranglerBin } from "../../cli/__fixtures__/d1.ts"
import { createD1Provider } from "../drivers/d1.ts"
import type { D1Target, ReadConfig } from "./d1-binding.ts"
import { hashStatements, historyTable, intentStatements, readHistory, vouched } from "./d1-history-rows.ts"
import { foldedMigrationHash, generateMigrationHash, legacyMigrationHash } from "./parse.ts"

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
		held: async () => false,
		wranglerConfig: join(dir, "wrangler.toml"),
	}
}

describe("readHistory", () => {
	it("reads a database with none of the history tables as nothing applied, recorded, intended or copied", async () => {
		expect(await readHistory(read, await target(), "d1_migrations")).toEqual({
			applied: new Set(),
			drizzle: undefined,
			intents: undefined,
			marks: true,
			recorded: new Map(),
		})
	})

	it("reads wrangler's names, comb's hashes and intents and the pre-0.8 record, a quote in a name kept", async () => {
		const d1 = await target()
		d1.db.exec(historyTable('my "history"'))
		d1.db.exec(`INSERT INTO "my ""history""" (name) VALUES ('1_it''s.sql')`)
		d1.db.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER)")
		d1.db.exec("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h0', 1)")
		await d1.conn.batch([
			...hashStatements([{ hash: "h1", marked: true, name: "1_it's.sql" }], true),
			...intentStatements([{ hash: "h2", name: "2_it's.sql" }]),
		])
		expect(await readHistory(read, d1, 'my "history"')).toEqual({
			applied: new Set(["1_it's.sql"]),
			drizzle: new Set(["h0"]),
			intents: new Map([["2_it's.sql", "h2"]]),
			marks: true,
			recorded: new Map([["1_it's.sql", { hash: "h1", marked: true }]]),
		})
	})

	/* SL5 of r22: a table comb 0.20 made has no hash_v, so every row of it is unmarked and the first write adds it */
	it("reads a hash table comb 0.20 made, without hash_v, as unmarked", async () => {
		const d1 = await target()
		d1.db.exec(historyTable("d1_migrations"))
		d1.db.exec("CREATE TABLE _comb_migration_hashes (name TEXT PRIMARY KEY, hash TEXT NOT NULL)")
		d1.db.exec("INSERT INTO _comb_migration_hashes (name, hash) VALUES ('1.sql', 'h1')")
		const history = await readHistory(read, d1, "d1_migrations")
		expect(history.marks).toBe(false)
		expect(history.recorded).toEqual(new Map([["1.sql", { hash: "h1", marked: false }]]))
	})
})

const unmarked = (hash: string) => ({ hash, marked: false })
const marked = (hash: string) => ({ hash, marked: true })

/* SL5 of r22 and M44: the hashes a recorded row may hold for a file's text */
describe("vouched", () => {
	const sql = "CREATE TABLE t (a\u00a0b);"

	/* no date tells which comb wrote a row: a 0.20.1 apply on any day records the folded hash, unmarked */
	it("takes the current hash on any record, and the folded one only on a record hash_v does not mark", () => {
		expect(vouched(sql, marked(generateMigrationHash(sql)), undefined)).toBe(true)
		expect(vouched(sql, unmarked(generateMigrationHash(sql)), undefined)).toBe(true)
		expect(vouched(sql, unmarked(foldedMigrationHash(sql)), undefined)).toBe(true)
		expect(vouched(sql, marked(foldedMigrationHash(sql)), undefined)).toBe(false)
	})

	it("takes the pre-0.5.0 hash only on an unmarked record where comb's pre-0.8 history holds it", () => {
		const legacy = legacyMigrationHash("SELECT '/* kept */';")
		expect(vouched("SELECT '/* kept */';", unmarked(legacy), undefined)).toBe(false)
		expect(vouched("SELECT '/* kept */';", unmarked(legacy), new Set([legacy]))).toBe(true)
		expect(vouched("SELECT '/* kept */';", marked(legacy), new Set([legacy]))).toBe(false)
		expect(vouched(sql, unmarked("other"), new Set(["other"]))).toBe(false)
	})
})

describe("hashStatements", () => {
	it("makes comb's table before any row, so the hashes can go first in any batch", () => {
		const rows = [
			{ hash: "h", marked: true, name: "a.sql" },
			{ hash: "f", marked: false, name: "b.sql" },
		]
		expect(hashStatements(rows, true).map((statement) => statement.sql)).toEqual([
			"CREATE TABLE IF NOT EXISTS _comb_migration_hashes (name TEXT PRIMARY KEY, hash TEXT NOT NULL, hash_v INTEGER)",
			"INSERT OR REPLACE INTO _comb_migration_hashes (name, hash, hash_v) VALUES ('a.sql', 'h', 2)",
			"INSERT OR REPLACE INTO _comb_migration_hashes (name, hash, hash_v) VALUES ('b.sql', 'f', NULL)",
		])
	})

	it("gives a table comb 0.20 made hash_v before any row", () => {
		expect(hashStatements([], false).map((statement) => statement.sql)).toEqual([
			"CREATE TABLE IF NOT EXISTS _comb_migration_hashes (name TEXT PRIMARY KEY, hash TEXT NOT NULL, hash_v INTEGER)",
			"ALTER TABLE _comb_migration_hashes ADD COLUMN hash_v INTEGER",
		])
	})
})
