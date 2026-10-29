import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type MemoryDb, openMemory } from "../drivers/memory.ts"
import { HISTORY_TABLES, notEngineTables } from "./engine-tables.ts"

let db: MemoryDb
beforeAll(async () => {
	db = await openMemory()
	db.exec(`CREATE TABLE post (id INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE TABLE _litestream_seq (id INTEGER PRIMARY KEY, seq INTEGER);
CREATE TABLE _litestream_lock (id INTEGER);
CREATE TABLE _cf_KV (key TEXT);
CREATE TABLE "a'%\\b" (x);
CREATE TABLE "a'x\\b" (x);
CREATE TABLE xlitestream_ (x);
CREATE TABLE __drizzle_migrations (id INTEGER);
CREATE TABLE d1_migrations (id INTEGER);
CREATE TABLE _comb_migration_hashes (name TEXT);
CREATE TABLE "it's" (x);`)
})
afterAll(() => db.close())

/** The tables `condition` keeps, by name */
const kept = (condition: string): string[] =>
	db
		.all(`SELECT name FROM sqlite_master WHERE type = 'table'${condition} ORDER BY name`)
		.map((row) => String(row["name"]))

describe("notEngineTables", () => {
	it("leaves out SQLite's and Litestream's tables, and D1's when the connection owns the prefix", () => {
		expect(kept(notEngineTables({}))).toEqual([
			"__drizzle_migrations",
			"_cf_KV",
			"_comb_migration_hashes",
			"a'%\\b",
			"a'x\\b",
			"d1_migrations",
			"it's",
			"post",
			"xlitestream_",
		])
		expect(kept(notEngineTables({ ownedPrefix: "_cf_" }))).not.toContain("_cf_KV")
	})

	it("reads a prefix's quotes, backslashes and wildcards as they are written", () => {
		expect(kept(notEngineTables({ ownedPrefix: "a'%\\" }))).toEqual(expect.arrayContaining(["a'x\\b"]))
		expect(kept(notEngineTables({ ownedPrefix: "a'%\\" }))).not.toContain("a'%\\b")
	})

	it("leaves out the history tables a reader names, quoted as they are written", () => {
		expect(kept(notEngineTables({}, [...HISTORY_TABLES, "it's"]))).toEqual([
			"_cf_KV",
			"a'%\\b",
			"a'x\\b",
			"post",
			"xlitestream_",
		])
	})
})
