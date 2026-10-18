/**
 * `comb migrate apply` and `baseline` as the README documents them, on a real SQLite file: the
 * database and its environment come from comb.migrate.config.ts, a destructive migration needs
 * --yes or a confirmation, and each file is applied and recorded together or not at all.
 */
import { createClient } from "@libsql/client"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../../src/cli/index.ts"
import { legacyMigrationHash } from "../../../src/migrate/core/parse.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

/** A project with comb.migrate.config.ts (a local and a staging environment) and its migrations */
function project(migrations: Record<string, string>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-migrate-cli-"))
	dirs.push(dir)
	fs.mkdirSync(path.join(dir, "atlas-migrations"))
	for (const [name, sql] of Object.entries(migrations)) fs.writeFileSync(path.join(dir, "atlas-migrations", name), sql)
	const url = (file: string) => `file:${path.join(dir, file)}`
	fs.writeFileSync(
		path.join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./atlas-migrations", environments: {
	local: { name: "core-local", provider: { type: "libsql", url: ${JSON.stringify(url("local.db"))} } },
	staging: { name: "core-staging", provider: { type: "libsql", url: ${JSON.stringify(url("staging.db"))} } },
} } } }\n`,
	)
	return { dir, url }
}

function io(dir: string, confirm?: (question: string) => Promise<boolean>) {
	const out: string[] = []
	const err: string[] = []
	return {
		confirm,
		cwd: dir,
		err: (line: string) => err.push(line),
		errors: err,
		out: (line: string) => out.push(line),
		outputs: out,
	}
}

async function tables(url: string): Promise<string[]> {
	const client = createClient({ url })
	try {
		const { rows } = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
		)
		return rows.map((row) => String(row[0]))
	} finally {
		client.close()
	}
}

describe("migrate apply through comb.migrate.config.ts (A-H4)", () => {
	it("applies the pending migrations to the environment -e names, and skips them the next time", async () => {
		const { dir, url } = project({ "20260101000000_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY);" })
		const first = io(dir)
		expect(await runCli(["migrate", "apply", "core", "-e", "staging"], first)).toBe(0)
		expect(await tables(url("staging.db"))).toEqual(["__drizzle_migrations", "post"])
		expect(fs.existsSync(path.join(dir, "local.db"))).toBe(false)
		const again = io(dir)
		expect(await runCli(["migrate", "apply", "core", "--env", "staging"], again)).toBe(0)
		expect(again.outputs.join("\n")).toContain("Skip (already applied): 20260101000000_init.sql")
	})

	it("says which environments exist when -e is missing or unknown", async () => {
		const { dir } = project({})
		for (const argv of [
			["migrate", "apply", "core"],
			["migrate", "apply", "core", "-e", "prod"],
		]) {
			const run = io(dir)
			expect(await runCli(argv, run)).toBe(1)
			expect(run.errors.join("\n")).toMatch(/local, staging/)
		}
	})
})

describe("migrate apply through comb.migrate.config.ts (A-H4): destructive and legacy migrations", () => {
	it("refuses a destructive migration without --yes or a confirmation, and applies nothing", async () => {
		const { dir, url } = project({
			"20260101000000_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY);",
			"20260102000000_drop.sql": "DROP TABLE post;",
		})
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], io(dir))).toBe(1)
		expect(await tables(url("local.db"))).toEqual(["__drizzle_migrations", "post"])

		const declined = io(dir, async () => false)
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], declined)).toBe(1)
		expect(await tables(url("local.db"))).toEqual(["__drizzle_migrations", "post"])

		const asked: string[] = []
		const accepted = io(dir, async (question) => (asked.push(question), true))
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], accepted)).toBe(0)
		expect(asked.join("\n")).toContain("DROP TABLE post")
		expect(await tables(url("local.db"))).toEqual(["__drizzle_migrations"])
	})

	it("applies a cautious migration with --yes without asking, and asks about an unsafe one unless the file approves it", async () => {
		const { dir, url } = project({
			"1_init.sql": "CREATE TABLE post (id TEXT);\nCREATE INDEX idx_post ON post (id);",
			"2_index.sql": "DROP INDEX idx_post;",
			"3_drop.sql": "DROP TABLE post;",
		})
		const asked: string[] = []
		const declined = io(dir, async (question) => (asked.push(question), false))
		expect(await runCli(["migrate", "apply", "core", "-e", "local", "--yes"], declined)).toBe(1)
		expect(asked).toHaveLength(1)
		expect(asked[0]).toContain("DROP TABLE post")
		expect(declined.errors.join("\n")).toContain("3_drop.sql is unsafe")
		expect(await tables(url("local.db"))).toEqual(["__drizzle_migrations", "post"])
		fs.writeFileSync(
			path.join(dir, "atlas-migrations", "3_drop.sql"),
			"-- comb:allow-unsafe: post is retired\nDROP TABLE post;",
		)
		expect(await runCli(["migrate", "apply", "core", "-e", "local", "--yes"], io(dir))).toBe(0)
		expect(await tables(url("local.db"))).toEqual(["__drizzle_migrations"])
	})

	it("skips a file recorded under its pre-0.5.0 hash", async () => {
		const sql = "INSERT INTO t VALUES ('a -- b\nc');"
		const { dir, url } = project({ "1_t.sql": "CREATE TABLE t (v TEXT);", "2_row.sql": sql })
		expect(await runCli(["migrate", "baseline", "core", "-e", "local"], io(dir))).toBe(0)
		const client = createClient({ url: url("local.db") })
		await client.execute("DELETE FROM __drizzle_migrations WHERE id = 2")
		await client.execute({
			args: [legacyMigrationHash(sql), Date.now()],
			sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
		})
		client.close()
		const run = io(dir)
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], run)).toBe(0)
		expect(run.outputs.join("\n")).toContain("Skip (already applied): 2_row.sql")
	})
})

describe("migrate baseline", () => {
	it("records every migration as applied without running its SQL", async () => {
		const { dir, url } = project({ "1_init.sql": "CREATE TABLE post (id TEXT);" })
		const run = io(dir)
		expect(await runCli(["migrate", "baseline", "core", "-e", "local"], run)).toBe(0)
		expect(await tables(url("local.db"))).toEqual(["__drizzle_migrations"])
		expect(run.outputs.join("\n")).toContain("Marked applied: 1_init.sql")
	})
})

describe("migrate options", () => {
	it("refuses an option it does not know, and one that is missing its value", async () => {
		const { dir } = project({})
		const unknown = io(dir)
		expect(await runCli(["migrate", "apply", "core", "--nope"], unknown)).toBe(1)
		expect(unknown.errors.join("\n")).toContain("Unknown option: --nope")
		const bare = io(dir)
		expect(await runCli(["migrate", "apply", "core", "-e"], bare)).toBe(1)
		expect(bare.errors.join("\n")).toContain("-e needs a value")
	})
})
