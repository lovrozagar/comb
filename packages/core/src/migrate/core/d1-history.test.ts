import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakeD1, localD1, writeSum } from "../../cli/__fixtures__/d1.ts"
import { createD1Provider } from "../drivers/d1.ts"
import { approveMigration } from "./approval.ts"
import { type D1Target, findWranglerConfig, type ReadConfig } from "./d1-binding.ts"
import { applyD1, statusD1 } from "./d1-history.ts"

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
	localD1(dir, { binding: "CORE", ...binding })
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

/* M31 of the 0.13 review: an applied file renamed or deleted is refused on D1, as on SQLite */
describe("applyD1 and statusD1 on an applied file renamed or deleted", () => {
	it("refuses a renamed applied file in check and apply rather than run it again, and names it in status", async () => {
		const { d1, read } = await target({})
		writeFileSync(join(d1.migrationsDir, "2_seed.sql"), "INSERT INTO post (id) VALUES ('seeded');")
		writeSum(d1.migrationsDir)
		expect(await applyD1(d1, { approve, print: () => undefined, read })).toEqual(["1_init.sql", "2_seed.sql"])
		renameSync(join(d1.migrationsDir, "2_seed.sql"), join(d1.migrationsDir, "2_seed_rows.sql"))
		writeSum(d1.migrationsDir)
		const refusal =
			/^1 applied migration matches no file in .* \(2_seed\.sql\): one was edited or renamed after it was applied/
		await expect(applyD1(d1, { approve, checkOnly: true, print: () => undefined, read })).rejects.toThrow(refusal)
		await expect(applyD1(d1, { approve, print: () => undefined, read })).rejects.toThrow(refusal)
		const lines: string[] = []
		await statusD1(d1, read, (line) => lines.push(line))
		expect(lines.join("\n")).toMatch(/1 applied migration matches no file in .* \(2_seed\.sql\)/)
		expect(await d1.conn.execute("SELECT count(*) FROM post")).toMatchObject({ rows: [[1]] })
	})

	it("refuses a deleted applied file in check, and names it in status", async () => {
		const { d1, read } = await target({})
		writeFileSync(join(d1.migrationsDir, "2_b.sql"), "CREATE TABLE b (id TEXT);")
		writeSum(d1.migrationsDir)
		await applyD1(d1, { approve, print: () => undefined, read })
		rmSync(join(d1.migrationsDir, "2_b.sql"))
		writeSum(d1.migrationsDir)
		await expect(applyD1(d1, { approve, checkOnly: true, print: () => undefined, read })).rejects.toThrow(
			/\(2_b\.sql\)/,
		)
		const lines: string[] = []
		await statusD1(d1, read, (line) => lines.push(line))
		expect(lines.join("\n")).toContain("(2_b.sql)")
	})
})

/* M32 of the 0.13 review: a file wrangler applied before it failed keeps its hash */
describe("applyD1 when wrangler fails partway", () => {
	it("records the hash of every checked file wrangler applied, then throws", async () => {
		const { d1, read } = await target({})
		writeFileSync(join(d1.migrationsDir, "2_u.sql"), "CREATE TABLE u (x TEXT UNIQUE);")
		writeSum(d1.migrationsDir)
		await applyD1(d1, { approve, print: () => undefined, read })
		await d1.conn.execute("INSERT INTO u (x) VALUES ('taken')")
		writeFileSync(join(d1.migrationsDir, "3_b.sql"), "CREATE TABLE b (id TEXT);")
		writeFileSync(join(d1.migrationsDir, "4_c.sql"), "INSERT INTO u (x) VALUES ('taken');")
		writeSum(d1.migrationsDir)
		await expect(applyD1(d1, { approve, print: () => undefined, read })).rejects.toThrow(
			/wrangler d1 migrations apply failed/,
		)
		const hashes = await d1.conn.execute("SELECT name FROM _comb_migration_hashes ORDER BY name")
		expect(hashes.rows.map((row) => row[0])).toEqual(["1_init.sql", "2_u.sql", "3_b.sql"])
		const lines: string[] = []
		await statusD1(d1, read, (line) => lines.push(line))
		expect(lines.join("\n")).not.toContain("No hash recorded")
	})
})

/* M33 of the 0.13 review: only a local database can be missing where comb looks for it */
describe("statusD1 on a local database wrangler keeps nowhere comb finds", () => {
	it("refuses locally, and reads a remote one with no local file", async () => {
		const { d1, read } = await target({})
		rmSync(join(dir, ".wrangler"), { force: true, recursive: true })
		await expect(statusD1(d1, read, () => undefined)).rejects.toThrow(
			/^comb cannot confirm CORE's local database exists/,
		)
		const remote = { ...d1, flags: ["--remote"] }
		await expect(statusD1(remote, read, () => undefined)).resolves.toEqual({ applied: [], pending: ["1_init.sql"] })
	})
})
