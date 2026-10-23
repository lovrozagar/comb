import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { approveMigration } from "./approval.ts"
import { planApply, type PlanOptions, wranglerOrder } from "./plan-apply.ts"
import { provePending } from "./proof-run.ts"
import { guardRebuilds } from "./rebuild-guard.ts"
import { extractSchema } from "./schema.ts"

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
	it("says once which tables the proof could not seed, and each file the copy refused, which is unsafe (M18)", async () => {
		const conn = libsqlConnection()
		await conn.client.executeMultiple(
			"CREATE TABLE codes (id INTEGER PRIMARY KEY, code TEXT NOT NULL CHECK (length(code) = 20)); CREATE TABLE post (id TEXT);",
		)
		const { out, run } = plan(
			{ "1_bad.sql": "ALTER TABLE missing ADD COLUMN x TEXT;", "2_ok.sql": "CREATE TABLE note (id TEXT);" },
			{ conn },
		)
		await expect(run()).rejects.toThrow(/^1_bad\.sql is unsafe \(proof run: comb could not run this in the proof copy/)
		expect(out).toEqual([
			"Proof run: 1_bad.sql, 2_ok.sql: unproven, comb could not seed codes (CHECK constraint failed: length(code) = 20)",
			"Proof run: 1_bad.sql: comb could not run this in the proof copy: ALTER TABLE missing ADD COLUMN x TEXT: no such table: missing",
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
	it("calls a delete unsafe though no seed row meets its predicate: the engine sees the delete, not the rows", async () => {
		const conn = libsqlConnection()
		await conn.client.executeMultiple("CREATE TABLE u (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT);")
		const file = "DELETE FROM u WHERE email LIKE '%@%';"
		const proof = (await provePending(conn, [{ name: "1_purge.sql", sql: file }])).get("1_purge.sql")
		expect(proof).toEqual({
			cautious: [],
			unproven: [],
			unsafe: ["DELETE FROM u WHERE email LIKE '%@%': deletes existing rows of u"],
		})
		await expect(plan({ "1_purge.sql": file }, { conn }).run()).rejects.toThrow(/^1_purge\.sql is unsafe/)
		await conn.close()
	})
})

/* the live guard names the cause; the proof's finding about the same rows reads like noise (M17) */
describe("planApply's live guard comes first", () => {
	it("refuses a rebuild the live database reaches beyond its history with the guard's reason, not the proof's", async () => {
		const init =
			"CREATE TABLE `u` (`id` integer PRIMARY KEY);\nCREATE TABLE `post` (`id` integer PRIMARY KEY, `u` integer REFERENCES `u`(`id`) ON DELETE CASCADE);"
		const rebuild = guardRebuilds(
			"CREATE TABLE `new_u` (`id` integer NOT NULL, PRIMARY KEY (`id`));\nINSERT INTO `new_u` (`id`) SELECT `id` FROM `u`;\nDROP TABLE `u`;\nALTER TABLE `new_u` RENAME TO `u`;\n",
			extractSchema(init),
		)
		const conn = libsqlConnection()
		await conn.client.executeMultiple(
			`${init}\nCREATE TABLE \`extra\` (\`u\` integer REFERENCES \`u\`(\`id\`) ON DELETE CASCADE);`,
		)
		const run = plan(
			{ "1_init.sql": init, "2_rebuild.sql": rebuild },
			{ applied: (name) => name === "1_init.sql", conn },
		).run()
		await expect(run).rejects.toThrow(/^2_rebuild\.sql rebuilds u, which the database's table extra references/)
		await conn.close()
	})
})

/* `_cf_` is D1's alone: on any other SQLite engine it is a user's table name (M8) */
describe("planApply on a table named _cf_… off D1", () => {
	it("counts it as the user's: the target is not empty, and its drop is unsafe", async () => {
		const conn = libsqlConnection()
		await conn.client.executeMultiple("CREATE TABLE _cf_audit (n INTEGER); INSERT INTO _cf_audit VALUES (1), (2);")
		const { out, run } = plan({ "1_drop.sql": "DROP TABLE _cf_audit;" }, { conn })
		await expect(run()).rejects.toThrow(/^1_drop\.sql is unsafe/)
		expect(out.join("\n")).not.toMatch(/Empty target/)
		await conn.close()
	})

	it("skips them on a connection whose engine owns the prefix, as D1 does", async () => {
		const conn = libsqlConnection()
		await conn.client.executeMultiple("CREATE TABLE _cf_KV (k TEXT);")
		const { out, run } = plan({ "1_init.sql": "CREATE TABLE t (id TEXT);" }, { conn: { ...conn, ownedPrefix: "_cf_" } })
		await run()
		expect(out.join("\n")).toMatch(/Empty target/)
		await conn.close()
	})
})

/* a D1 binding's custom migrations_table is a history table too, made by apply before it plans (M13) */
describe("planApply on a database holding only its migration history", () => {
	it("calls a target empty whose only table is the history it is told of", async () => {
		const conn = libsqlConnection()
		await conn.client.executeMultiple("CREATE TABLE schema_history (id INTEGER PRIMARY KEY, name TEXT);")
		const files = { "1_init.sql": "DROP TABLE IF EXISTS legacy;\nCREATE TABLE t (id TEXT);" }
		const told = plan(files, { conn, historyTables: ["schema_history"] })
		await told.run()
		expect(told.out.join("\n")).toMatch(/Empty target/)
		await expect(plan(files, { conn }).run()).rejects.toThrow(/^1_init\.sql is unsafe/)
		await conn.close()
	})
})
