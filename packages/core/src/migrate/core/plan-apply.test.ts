import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { approveMigration } from "./approval.ts"
import { planApply, type PlanOptions, wranglerOrder } from "./plan-apply.ts"
import { provePending } from "./proof-run.ts"

describe("wranglerOrder", () => {
	it("orders by leading number, then by name, files without a number last", () => {
		expect(wranglerOrder(["20250101000000_b.sql", "notes.sql", "20261020_a.sql", "9_z.sql", "9_y.sql"])).toEqual([
			"9_y.sql",
			"9_z.sql",
			"20261020_a.sql",
			"20250101000000_b.sql",
			"notes.sql",
		])
		expect(wranglerOrder(["b.sql", "a.sql", "a.sql"])).toEqual(["a.sql", "a.sql", "b.sql"])
	})
})

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-plan-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** A plan over `files` in `dir`, nothing applied and no sum checked unless asked */
function plan(files: Record<string, string>, more: Partial<PlanOptions> = {}) {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	const out: string[] = []
	return {
		out,
		run: () =>
			planApply({
				applied: () => false,
				approve: (migration) => approveMigration(migration, { target: "core", yes: true }),
				dir,
				exec: () => ({ code: 0, stderr: "", stdout: "" }),
				files: Object.keys(files),
				print: (line) => out.push(line),
				whole: false,
				...more,
			}),
	}
}

describe("planApply", () => {
	it("classifies each pending file against the files before it, an applied one included, and says who approved it", async () => {
		const run = plan(
			{
				"1_a.sql": "CREATE TABLE t (id TEXT, a TEXT);",
				"2_b.sql":
					"-- comb:allow-unsafe: a is retired\nCREATE TABLE new_t (id TEXT);\nINSERT INTO new_t (id) SELECT id FROM t;\nDROP TABLE t;\nALTER TABLE new_t RENAME TO t;",
			},
			{ applied: (name) => name === "1_a.sql" },
		)
		const pending = await run.run()
		expect(pending.map(({ migration, name }) => [name, migration.classification.safety])).toEqual([
			["2_b.sql", "unsafe"],
		])
		expect(pending[0]?.before.tables.get("t")).toEqual(["id", "a"])
		expect(run.out).toEqual(["Approved in 2_b.sql: a is retired"])
	})

	it("stops at the first file it may not run", async () => {
		await expect(plan({ "1_drop.sql": "DROP TABLE t;" }).run()).rejects.toThrow(/^1_drop\.sql is unsafe/)
	})
})

describe("planApply's proof run, on a database it reads", () => {
	it("says which tables the proof could not seed, and a file the copy refused, and keeps the classifier's rating", async () => {
		const conn = libsqlConnection()
		await conn.client.executeMultiple(
			"CREATE TABLE codes (id INTEGER PRIMARY KEY, code TEXT NOT NULL CHECK (length(code) = 20)); CREATE TABLE post (id TEXT);",
		)
		const { out, run } = plan(
			{ "1_bad.sql": "ALTER TABLE missing ADD COLUMN x TEXT;", "2_ok.sql": "CREATE TABLE note (id TEXT);" },
			{ conn },
		)
		await run()
		expect(out).toEqual([
			"Proof run: 1_bad.sql: it did not apply to the copy: no such table: missing; its rating is the classifier's",
			"Proof run: 1_bad.sql: unproven, comb could not seed codes (CHECK constraint failed: length(code) = 20)",
			"Proof run: 2_ok.sql: an earlier pending file, 1_bad.sql, did not apply to the copy; its rating is the classifier's",
			"Proof run: 2_ok.sql: unproven, comb could not seed codes (CHECK constraint failed: length(code) = 20)",
		])
		await conn.close()
	})
})

describe("planApply joining a proof to the classification", () => {
	it("lists what the proof found beside what the classifier found", async () => {
		const conn = libsqlConnection()
		await conn.client.executeMultiple("CREATE TABLE users (id INTEGER PRIMARY KEY, tier TEXT);")
		const rebuild =
			"CREATE TABLE new_users (id INTEGER PRIMARY KEY, tier TEXT NOT NULL DEFAULT '');\nINSERT INTO new_users (id, tier) SELECT id, IFNULL(tier, '') AS tier FROM users;\nDROP TABLE users;\nALTER TABLE new_users RENAME TO users;"
		const seen: string[][] = []
		const { run } = plan(
			{ "1_init.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY, tier TEXT);", "2_rebuild.sql": rebuild },
			{
				applied: (name) => name === "1_init.sql",
				approve: async (migration) => (seen.push(migration.classification.cautiousStatements), { ok: true }),
				conn,
			},
		)
		await run()
		expect(seen[0]).toContain("proof run: fills users.tier's NULLs with its default")
		await conn.close()
	})
})

describe("the proof only adds strictness (G1b)", () => {
	it("keeps the classifier's unsafe for a file whose predicate no seed row meets, though its proof is clean", async () => {
		const conn = libsqlConnection()
		await conn.client.executeMultiple("CREATE TABLE u (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT);")
		const file = "DELETE FROM u WHERE email LIKE '%@%';"
		const proof = (await provePending(conn, [{ name: "1_purge.sql", sql: file }])).get("1_purge.sql")
		expect(proof).toEqual({ cautious: [], unproven: [], unsafe: [] })
		await expect(plan({ "1_purge.sql": file }, { conn }).run()).rejects.toThrow(/^1_purge\.sql is unsafe/)
		await conn.close()
	})
})
