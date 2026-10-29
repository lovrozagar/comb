import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakeD1, localD1, writeSum } from "../../cli/__fixtures__/d1.ts"
import { createD1Provider } from "../drivers/d1.ts"
import { approveMigration } from "./approval.ts"
import { type D1Target, findWranglerConfig, type ReadConfig } from "./d1-binding.ts"
import { applyD1, statusD1 } from "./d1-history.ts"
import { legacyMigrationHash } from "./parse.ts"

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

/** The `wrangler d1 execute` calls a fake took, each its own process on a real wrangler */
const executes = (run: { calls: string[][] }) =>
	run.calls.filter(([cmd, sub, verb]) => cmd === "wrangler" && sub === "d1" && verb === "execute").length

/* R1: every wrangler call is a process of its own, so comb reads its history in one */
describe("applyD1 and statusD1: wrangler calls", () => {
	it("reads the history in one call, the schema in two, and the result and hashes in one each", async () => {
		const { apply, d1, read, run } = await target({})
		expect(await apply()).toEqual(["1_init.sql"])
		expect(executes(run)).toBe(5)
		run.calls.length = 0
		await statusD1(d1, read, () => undefined)
		expect(executes(run)).toBe(2)
	})
})

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
describe("statusD1 on a hash a 0.13 baseline copied from comb's pre-0.8 history", () => {
	/* M44: a 0.13 baseline recorded the pre-0.5.0 hash drizzle held; drizzle still holding it proves the record is that old */
	it("takes a pre-0.5.0 hash only where comb's pre-0.8 history still holds it for the file", async () => {
		const { d1, read } = await target({})
		const sql = "CREATE TABLE post (id TEXT DEFAULT 'a -- b\nc');"
		writeFileSync(join(d1.migrationsDir, "1_init.sql"), sql)
		writeSum(d1.migrationsDir)
		expect(await applyD1(d1, { approve, print: () => undefined, read })).toEqual(["1_init.sql"])
		const legacy = legacyMigrationHash(sql)
		await d1.conn.execute("UPDATE _comb_migration_hashes SET hash = ? WHERE name = '1_init.sql'", [legacy])
		await expect(statusD1(d1, read, () => undefined)).rejects.toThrow(/^1_init\.sql was applied, then edited/)
		await d1.conn.execute("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER)")
		await d1.conn.execute("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('other', 1)")
		await expect(statusD1(d1, read, () => undefined)).rejects.toThrow(/^1_init\.sql was applied, then edited/)
		await d1.conn.execute("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, 1)", [legacy])
		const lines: string[] = []
		await statusD1(d1, read, (line) => lines.push(line))
		expect(lines).toEqual(["Applied: 1_init.sql", "Pending: none"])
	})
})

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

	/* M44: the pre-0.5.0 normalizing hides an edit inside a string literal, so D1 compares the current hash only */
	it("refuses a file edited inside a string literal, which the pre-0.5.0 hash cannot tell", async () => {
		const { d1, read } = await target({})
		writeFileSync(join(d1.migrationsDir, "1_init.sql"), "CREATE TABLE post (id TEXT DEFAULT 'hello world');")
		writeSum(d1.migrationsDir)
		expect(await applyD1(d1, { approve, print: () => undefined, read })).toEqual(["1_init.sql"])
		writeFileSync(join(d1.migrationsDir, "1_init.sql"), "CREATE TABLE post (id TEXT DEFAULT 'hello\n\n   world');")
		writeSum(d1.migrationsDir)
		await expect(statusD1(d1, read, () => undefined)).rejects.toThrow(/^1_init\.sql was applied, then edited/)
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

/* S5 of the 0.15.0 review: comb makes no table before wrangler runs, so a failed run may leave none */
describe("applyD1 when wrangler fails before it makes its table", () => {
	it("passes on wrangler's own error, not the missing table's", async () => {
		const { d1, read, run } = await target({})
		const early: D1Target = {
			...d1,
			exec: (cmd, args, options) =>
				args[1] === "migrations"
					? { code: 1, stderr: "✘ [ERROR] Authentication error [code: 10000]", stdout: "" }
					: run(cmd, args, options),
		}
		await expect(applyD1(early, { approve, print: () => undefined, read })).rejects.toThrow(
			"wrangler d1 migrations apply failed: ✘ [ERROR] Authentication error [code: 10000]",
		)
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

/* S1 of the 0.14.1 review: wrangler sends each file with its history INSERT appended on the next line */
describe("applyD1 on a file whose end would swallow wrangler's history INSERT", () => {
	it.each([
		["an open block comment", "CREATE TABLE b (id TEXT);\n/* the rest", "ends inside an open /* comment"],
		["no final semicolon", "CREATE TABLE b (id TEXT)", "does not end its last statement with ;"],
		["a string left open", "INSERT INTO post (id) VALUES ('x", "does not end its last statement with ;"],
	])("refuses in check a pending file ending in %s", async (_, sql, reason) => {
		const { d1, read } = await target({})
		writeFileSync(join(d1.migrationsDir, "2_b.sql"), sql)
		writeSum(d1.migrationsDir)
		await expect(applyD1(d1, { approve, checkOnly: true, print: () => undefined, read })).rejects.toThrow(
			`2_b.sql ${reason}`,
		)
	})

	it("passes a file ending in a closed comment or a line comment after its semicolon", async () => {
		const { d1, read } = await target({})
		writeFileSync(join(d1.migrationsDir, "2_b.sql"), "CREATE TABLE b (id TEXT); /* done */\n-- the end")
		writeSum(d1.migrationsDir)
		expect(await applyD1(d1, { approve, checkOnly: true, print: () => undefined, read })).toEqual([
			"1_init.sql",
			"2_b.sql",
		])
	})
})

/* S4, C8 of the 0.14.1 review: the files wrangler runs, in its order, must be Atlas's, in its */
describe("applyD1 on a directory wrangler lists otherwise than Atlas", () => {
	it("refuses a dot-named file, which wrangler skips and Atlas applies, with a rename", async () => {
		const { d1, read } = await target({})
		writeFileSync(join(d1.migrationsDir, ".2_b.sql"), "CREATE TABLE b (id TEXT);")
		writeSum(d1.migrationsDir)
		await expect(applyD1(d1, { approve, checkOnly: true, print: () => undefined, read })).rejects.toThrow(
			".2_b.sql starts with a dot, so wrangler never applies it, while Atlas does; rename it without the dot",
		)
	})

	it("refuses files whose number order is not their name order, naming the one to rename", async () => {
		const { d1, read } = await target({})
		writeFileSync(join(d1.migrationsDir, "9_b.sql"), "CREATE TABLE b (id TEXT);")
		writeFileSync(join(d1.migrationsDir, "10_c.sql"), "CREATE TABLE c (id TEXT);")
		writeSum(d1.migrationsDir)
		await expect(applyD1(d1, { approve, checkOnly: true, print: () => undefined, read })).rejects.toThrow(
			"10_c.sql runs after 1_init.sql under wrangler, by number, but before it under Atlas, by name; rename 10_c.sql",
		)
	})
})

/* S3, C4 of the 0.14.1 review: what wrangler applied before it stopped is reported, and its hashes kept */
/** The files comb recorded a hash for */
const hashed = async (d1: D1Target) =>
	(await d1.conn.execute("SELECT name FROM _comb_migration_hashes ORDER BY name")).rows.map((row) => row[0])

describe("applyD1 when wrangler stops short", () => {
	it("records what wrangler applied and names the rest when it records fewer files than comb checked", async () => {
		const { d1, read, run } = await target({})
		/* a wrangler that applies the first pending file only, and exits 0 */
		const short: typeof d1.exec = (cmd, args, options) => {
			if (cmd === "wrangler" && args[1] === "migrations") {
				rmSync(join(d1.migrationsDir, "3_c.sql"))
				const result = run(cmd, args, options)
				writeFileSync(join(d1.migrationsDir, "3_c.sql"), "CREATE TABLE c (id TEXT);")
				return result
			}
			return run(cmd, args, options)
		}
		writeFileSync(join(d1.migrationsDir, "2_b.sql"), "CREATE TABLE b (id TEXT);")
		writeFileSync(join(d1.migrationsDir, "3_c.sql"), "CREATE TABLE c (id TEXT);")
		writeSum(d1.migrationsDir)
		const error = await applyD1({ ...d1, exec: short }, { approve, print: () => undefined, read }).catch(
			(e: Error) => e,
		)
		expect(error).toMatchObject({ applied: ["1_init.sql", "2_b.sql"], pending: ["3_c.sql"] })
		expect(await hashed(d1)).toEqual(["1_init.sql", "2_b.sql"])
	})

	it("reports what wrangler applied before it failed, and its error line without colours or banner", async () => {
		const { d1, read, run } = await target({})
		const coloured: typeof d1.exec = (cmd, args, options) => {
			const result = run(cmd, args, options)
			if (cmd !== "wrangler" || args[1] !== "migrations" || result.code === 0) return result
			return {
				...result,
				stderr: `\u001b[1m⛅️ wrangler 4.0.0\u001b[0m\n---\n\u001b[31m✘ [ERROR]\u001b[0m ${result.stderr}\n`,
			}
		}
		writeFileSync(join(d1.migrationsDir, "2_b.sql"), "CREATE TABLE b (id TEXT);")
		writeFileSync(join(d1.migrationsDir, "3_c.sql"), "INSERT INTO nope (id) VALUES ('x');")
		writeSum(d1.migrationsDir)
		const error = (await applyD1({ ...d1, exec: coloured }, { approve, print: () => undefined, read }).catch(
			(e: unknown) => e,
		)) as Error
		expect(error).toMatchObject({ applied: ["1_init.sql", "2_b.sql"], pending: ["3_c.sql"] })
		expect(error.message).toBe(
			"wrangler d1 migrations apply failed: ✘ [ERROR] Migration 3_c.sql failed: no such table: nope",
		)
		expect(await hashed(d1)).toEqual(["1_init.sql", "2_b.sql"])
	})
})
