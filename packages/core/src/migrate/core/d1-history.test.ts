import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakeD1, writeSum } from "../../cli/__fixtures__/d1.ts"
import { createD1Provider } from "../drivers/d1.ts"
import { approveMigration } from "./approval.ts"
import { applyD1, type D1Target, findWranglerConfig, type ReadConfig, statusD1 } from "./d1-history.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-d1-history-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

describe("findWranglerConfig", () => {
	it("takes wrangler.json over wrangler.jsonc over wrangler.toml, as wrangler does, and none when there is none", () => {
		expect(findWranglerConfig(dir)).toBeUndefined()
		for (const name of ["wrangler.toml", "wrangler.jsonc", "wrangler.json"]) {
			writeFileSync(join(dir, name), "")
			expect(findWranglerConfig(dir)).toBe(join(dir, name))
		}
	})
})

const approve = (migration: Parameters<typeof approveMigration>[0]) =>
	approveMigration(migration, { target: "core", yes: false })

/** The D1 target of a binding with `d1`'s settings, its migrations in dir/migrations */
async function target(binding: Record<string, string>) {
	const migrations = join(dir, "migrations")
	mkdirSync(migrations)
	writeFileSync(join(migrations, "1_init.sql"), "CREATE TABLE post (id TEXT);")
	writeSum(migrations)
	const run = fakeD1({ dir: migrations })
	const config = { databaseName: "core", local: true, type: "d1" as const }
	const conn = await createD1Provider(config, run).connect({
		migrationsDir: migrations,
		name: "core",
		provider: config,
	})
	const read: ReadConfig = () => ({
		d1_databases: [{ binding: "CORE", ...binding }],
	})
	const d1: D1Target = {
		conn,
		exec: run,
		flags: ["--local"],
		migrationsDir: migrations,
		name: "CORE",
		wranglerConfig: join(dir, "wrangler.toml"),
	}
	return { apply: () => applyD1(d1, { approve, print: () => undefined, read }), d1, read, run }
}

describe("applyD1: the binding", () => {
	it("reads wrangler's default migrations directory, and a pattern that names every .sql file of it", async () => {
		const { apply } = await target({ migrations_pattern: "./migrations/*.sql" })
		expect(await apply()).toEqual(["1_init.sql"])
	})
})

/** Every name in a D1 target's sqlite_master */
const tables = async (d1: D1Target) =>
	(await d1.conn.execute("SELECT name FROM sqlite_master ORDER BY name")).rows.map((row) => String(row[0]))

describe("statusD1 and a check on a database without the migrations table", () => {
	it("read it as nothing applied and leave sqlite_master unchanged", async () => {
		const { d1, read } = await target({})
		const lines: string[] = []
		const before = await tables(d1)
		await statusD1(d1, read, (line) => lines.push(line))
		expect(lines).toEqual(["Applied: none", "Pending: 1_init.sql"])
		expect(await applyD1(d1, { approve, checkOnly: true, print: () => undefined, read })).toEqual(["1_init.sql"])
		expect(await tables(d1)).toEqual(before)
		expect(before).not.toContain("d1_migrations")
	})
})

/* M17 of the 0.12 round: D1's history holds names only, so comb records each applied file's hash itself */
describe("applyD1 and statusD1 on an applied file edited since", () => {
	it("records each applied file's hash, and refuses the file edited since, in check, apply and status", async () => {
		const { d1, read } = await target({})
		expect(await applyD1(d1, { approve, print: () => undefined, read })).toEqual(["1_init.sql"])
		writeFileSync(join(d1.migrationsDir, "1_init.sql"), "CREATE TABLE post (id TEXT, body TEXT);")
		writeSum(d1.migrationsDir)
		const refusal = /^1_init\.sql was applied, then edited: its hash is not the one comb recorded/
		await expect(applyD1(d1, { approve, checkOnly: true, print: () => undefined, read })).rejects.toThrow(refusal)
		await expect(applyD1(d1, { approve, print: () => undefined, read })).rejects.toThrow(refusal)
		await expect(statusD1(d1, read, () => undefined)).rejects.toThrow(refusal)
	})

	it("says which applied files comb has no hash for, so cannot tell edited", async () => {
		const { d1, read } = await target({})
		await d1.conn.execute(
			"CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
		)
		await d1.conn.execute("INSERT INTO d1_migrations (name) VALUES ('1_init.sql')")
		const lines: string[] = []
		await statusD1(d1, read, (line) => lines.push(line))
		expect(lines).toContain(
			"No hash recorded for 1_init.sql, applied before comb recorded them: comb cannot tell whether it was edited since",
		)
	})

	it("names every such file, and says they", async () => {
		const { d1, read } = await target({})
		writeFileSync(join(d1.migrationsDir, "2_more.sql"), "CREATE TABLE more (id TEXT);")
		writeSum(d1.migrationsDir)
		await d1.conn.execute(
			"CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
		)
		await d1.conn.execute("INSERT INTO d1_migrations (name) VALUES ('1_init.sql'), ('2_more.sql')")
		const lines: string[] = []
		await statusD1(d1, read, (line) => lines.push(line))
		expect(lines).toContain(
			"No hash recorded for 1_init.sql, 2_more.sql, applied before comb recorded them: comb cannot tell whether they were edited since",
		)
	})
})
