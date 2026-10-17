import { createClient } from "@libsql/client"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Run } from "../migrate/core/process.ts"
import { makeIo, ok, projects } from "./__fixtures__/io.ts"
import { runCli } from "./run.ts"

const temp = projects()
const project = temp.make
afterEach(temp.clean)

/** A project with comb.migrate.config.ts over a libsql file, and these migrations in ./m */
function configured(migrations: Record<string, string>): { dir: string; url: string } {
	const dir = project()
	const url = `file:${join(dir, "core.db")}`
	mkdirSync(join(dir, "m"))
	for (const [name, sql] of Object.entries(migrations)) writeFileSync(join(dir, "m", name), sql)
	writeFileSync(
		join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./m", name: "core-dev", provider: { type: "libsql", url: ${JSON.stringify(url)} } } } }\n`,
	)
	return { dir, url }
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

describe("migrate apply: arguments", () => {
	it("prints apply usage when the database name is missing, and a missing dir", async () => {
		const dir = project()
		const usage = makeIo(dir)
		expect(await runCli(["migrate", "apply"], usage)).toBe(1)
		expect(usage.errors).toEqual([
			"Usage: comb migrate apply <database> [-e <env>] [--dir <path>] [--file <path>] [--yes] [--local]",
		])
		const baseline = makeIo(dir)
		expect(await runCli(["migrate", "baseline"], baseline)).toBe(1)
		expect(baseline.errors).toEqual(["Usage: comb migrate baseline <database> [-e <env>] [--dir <path>] [--local]"])
		const extra = makeIo(dir)
		expect(await runCli(["migrate", "apply", "core", "blog"], extra)).toBe(1)
		const missing = makeIo(dir)
		expect(await runCli(["migrate", "baseline", "core", "--dir", "nowhere"], missing)).toBe(1)
		expect(missing.errors).toEqual([`Migrations dir not found: ${join(dir, "nowhere")}`])
	})
})

describe("migrate apply: through comb.migrate.config.ts", () => {
	it("applies, then skips what it applied, and names the database it applied to", async () => {
		const { dir, url } = configured({ "1_init.sql": "CREATE TABLE post (id TEXT);" })
		const first = makeIo(dir)
		expect(await runCli(["migrate", "apply", "core"], first)).toBe(0)
		expect(first.outputs).toEqual(["Apply: 1_init.sql", "\nDone: 1 applied, 0 skipped"])
		expect(await tables(url)).toEqual(["__drizzle_migrations", "post"])
		const again = makeIo(dir)
		expect(await runCli(["migrate", "apply", "core"], again)).toBe(0)
		expect(again.outputs).toEqual(["Skip (already applied): 1_init.sql", "\nDone: 0 applied, 1 skipped"])
	})

	it("takes one file with --file and another directory with --dir", async () => {
		const { dir, url } = configured({})
		mkdirSync(join(dir, "other"))
		writeFileSync(join(dir, "other", "1_a.sql"), "CREATE TABLE a (x);")
		writeFileSync(join(dir, "lone.sql"), "CREATE TABLE lone (x);")
		expect(await runCli(["migrate", "apply", "core", "--file", "lone.sql"], makeIo(dir))).toBe(0)
		expect(await runCli(["migrate", "apply", "core", "--dir", "other"], makeIo(dir))).toBe(0)
		expect(await tables(url)).toEqual(["__drizzle_migrations", "a", "lone"])
	})

	it("asks before a destructive migration, and refuses it when nobody can be asked or the answer is no", async () => {
		const { dir, url } = configured({ "1_init.sql": "CREATE TABLE post (id TEXT);", "2_drop.sql": "DROP TABLE post;" })
		const refused = makeIo(dir)
		expect(await runCli(["migrate", "apply", "core"], refused)).toBe(1)
		expect(refused.errors).toEqual([
			"2_drop.sql is destructive (DROP TABLE post); pass --yes or confirm it on a terminal",
		])
		const asked: string[] = []
		expect(
			await runCli(
				["migrate", "apply", "core"],
				makeIo(dir, undefined, async (q) => (asked.push(q), false)),
			),
		).toBe(1)
		expect(asked[0]).toContain("This affects: core (core-dev)")
		expect(await tables(url)).toEqual(["__drizzle_migrations", "post"])
		expect(await runCli(["migrate", "apply", "core", "--yes"], makeIo(dir))).toBe(0)
		expect(await tables(url)).toEqual(["__drizzle_migrations"])
	})

	it("refuses a database the config does not declare, and --local", async () => {
		const { dir } = configured({})
		const unknown = makeIo(dir)
		expect(await runCli(["migrate", "apply", "blog"], unknown)).toBe(1)
		expect(unknown.errors).toEqual(['comb.migrate.config.ts declares no database "blog". Available: core'])
		const local = makeIo(dir)
		expect(await runCli(["migrate", "apply", "core", "--local"], local)).toBe(1)
		expect(local.errors[0]).toContain("--local applies without comb.migrate.config.ts")
	})
})

describe("migrate baseline", () => {
	it("records each migration as applied without running it, and skips what is recorded", async () => {
		const { dir, url } = configured({ "1_init.sql": "CREATE TABLE post (id TEXT);" })
		const io = makeIo(dir)
		expect(await runCli(["migrate", "baseline", "core"], io)).toBe(0)
		expect(io.outputs).toEqual(["Marked applied: 1_init.sql", "\nBaseline done: 1 marked, 0 already tracked"])
		expect(await tables(url)).toEqual(["__drizzle_migrations"])
		const again = makeIo(dir)
		expect(await runCli(["migrate", "baseline", "core"], again)).toBe(0)
		expect(again.outputs).toEqual(["\nBaseline done: 0 marked, 1 already tracked"])
	})
})

/** wrangler as the D1 driver calls it: JSON for --command, nothing for --file */
function wrangler(): Run & { calls: string[][]; files: string[] } {
	const calls: string[][] = []
	const files: string[] = []
	const run: Run = (cmd, args) => {
		calls.push([cmd, ...args])
		const file = args.find((a) => a.startsWith("--file="))
		if (file) files.push(readFileSync(file.slice("--file=".length), "utf8"))
		return args.includes("--json") ? ok(JSON.stringify([{ results: [] }])) : ok("[]")
	}
	return Object.assign(run, { calls, files })
}

describe("migrate apply: the D1 database named on the command line", () => {
	it("applies remotely by default and locally with --local, migration and record in one file", async () => {
		const dir = project()
		mkdirSync(join(dir, "atlas-migrations"))
		writeFileSync(join(dir, "atlas-migrations", "1_init.sql"), "CREATE TABLE post (id TEXT);")
		for (const [flags, target] of [
			[[], "--remote"],
			[["--local"], "--local"],
		] as const) {
			const run = wrangler()
			expect(await runCli(["migrate", "apply", "core", ...flags], makeIo(dir, run))).toBe(0)
			expect(run.calls.every((call) => call.includes(target) && call[3] === "core")).toBe(true)
			expect(run.files).toHaveLength(1)
			expect(run.files[0]).toMatch(
				/CREATE TABLE post \(id TEXT\)\n;\nINSERT INTO __drizzle_migrations \(hash, created_at\) VALUES \('[0-9a-f]{64}', \d+\)\n;/,
			)
		}
	})

	it("refuses -e without a migrate config to define environments", async () => {
		const io = makeIo(project(), wrangler())
		expect(await runCli(["migrate", "apply", "core", "-e", "prod"], io)).toBe(1)
		expect(io.errors).toEqual(["-e/--env needs comb.migrate.config.ts to define environments"])
	})
})
