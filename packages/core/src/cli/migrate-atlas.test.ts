import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Run } from "../migrate/core/process.ts"
import { makeIo, ok, projects } from "./__fixtures__/io.ts"
import { runCli } from "./run.ts"

const temp = projects()
const project = temp.make
afterEach(temp.clean)

/** Atlas on an empty Postgres database: hash sums file names, status lists `pending`, apply applies them, set records */
function pgAtlas(pending: string[]): Run & { calls: string[][]; envs: unknown[] } {
	const calls: string[][] = []
	const envs: unknown[] = []
	const run: Run = (_cmd, args, options) => {
		calls.push([...args])
		envs.push(options?.env)
		const dirAt = args.indexOf("--dir")
		const dir = dirAt === -1 ? "" : (args[dirAt + 1] as string).replace("file://", "")
		if (args[1] === "hash") {
			const names = readdirSync(dir)
				.filter((f) => f.endsWith(".sql"))
				.sort()
			writeFileSync(join(dir, "atlas.sum"), `h1:x=\n${names.map((f) => `${f} h1:${f.length}=`).join("\n")}\n`)
			return ok()
		}
		/* an empty database, for a check of one with no history; a diff finds it synced */
		if (args[0] === "schema") return ok(args[1] === "inspect" ? "{}" : "Schemas are synced, no changes to be made.\n")
		const files = pending.map((Name) => ({ Description: "", Name, Version: Name.split("_")[0] }))
		if (args[1] === "status")
			return ok(
				JSON.stringify({ applied: [], available: files, current: "", error: "", pending: files, status: "PENDING" }),
			)
		if (args[1] === "apply")
			return ok(JSON.stringify({ applied: files.map(({ Name }) => ({ Name })), error: "", target: "" }))
		return ok()
	}
	return Object.assign(run, { calls, envs })
}

/** A project whose comb.migrate.config.ts declares a Postgres `core`, with these migrations hashed into ./pg */
function postgresProject(
	migrations: Record<string, string>,
	url = "postgres://app:pw@db.example.com/app?sslmode=verify-full",
): string {
	const dir = project()
	mkdirSync(join(dir, "pg"))
	for (const [name, sql] of Object.entries(migrations)) writeFileSync(join(dir, "pg", name), sql)
	pgAtlas([])("atlas", ["migrate", "hash", "--dir", `file://${join(dir, "pg")}`])
	writeFileSync(
		join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./pg", name: "core", provider: { type: "postgres", url: ${JSON.stringify(url)} } } } }\n`,
	)
	return dir
}

describe("migrate apply and baseline: a Postgres database, through Atlas", () => {
	it("applies the pending files through Atlas, the URL in its environment only", async () => {
		const dir = postgresProject({ "1_init.sql": 'CREATE TABLE "post" ("id" integer);\n' })
		const atlas = pgAtlas(["1_init.sql"])
		const io = makeIo(dir, atlas)
		expect(await runCli(["migrate", "apply", "core"], io)).toBe(0)
		expect(io.outputs).toEqual(["Apply: 1_init.sql", "\nDone: 1 applied"])
		expect(atlas.calls.map((call) => call.join(" ")).join("\n")).not.toContain("pw@")
	})

	it("checks and approves the pending files with check, applying none", async () => {
		const dir = postgresProject({ "1_init.sql": 'CREATE TABLE "post" ("id" integer);\n' })
		const atlas = pgAtlas(["1_init.sql"])
		const io = makeIo(dir, atlas)
		expect(await runCli(["migrate", "check", "core"], io)).toBe(0)
		expect(io.outputs).toEqual(["\nCheck passed: 1 pending: 1_init.sql"])
		expect(atlas.calls.some((call) => call[1] === "apply" && !call.includes("--dry-run"))).toBe(false)
	})

	it("asks before an unsafe file, and takes no --yes for it", async () => {
		const dir = postgresProject({ "1_drop.sql": 'DROP TABLE "post";\n' })
		const io = makeIo(dir, pgAtlas(["1_drop.sql"]))
		expect(await runCli(["migrate", "apply", "core", "--yes"], io)).toBe(1)
		expect(io.errors[0]).toContain('1_drop.sql is unsafe (DROP TABLE "post");')
	})
})

describe("migrate baseline and its refusals: a Postgres database, through Atlas", () => {
	it("records every file with baseline, running none", async () => {
		const dir = postgresProject({ "1_init.sql": "SELECT 1;\n", "2_more.sql": "SELECT 2;\n" })
		const atlas = pgAtlas([])
		const io = makeIo(dir, atlas)
		expect(await runCli(["migrate", "baseline", "core"], io)).toBe(0)
		expect(atlas.calls.find((call) => call[1] === "set")?.slice(0, 3)).toEqual(["migrate", "set", "2"])
		expect(io.outputs).toEqual([
			"Marked applied: 1_init.sql",
			"Marked applied: 2_more.sql",
			"\nBaseline done: 2 marked",
		])
	})

	/* M75: baseline replays the history as Postgres's parser reads it, so it loads it first */
	it("loads the Postgres parser itself before baseline reads the history", async () => {
		const dir = postgresProject({ "1_init.sql": 'CREATE TABLE "post" ("id" integer);\n' })
		/* a fresh module graph: the setup file loaded the parser in the one the other tests share */
		vi.resetModules()
		const fresh = await import("./run.ts")
		const io = makeIo(dir, pgAtlas([]))
		expect(await fresh.runCli(["migrate", "baseline", "core"], io)).toBe(0)
		expect(io.outputs.at(-1)).toBe("\nBaseline done: 1 marked")
	})

	it("refuses --file and --local, which Atlas has no use for", async () => {
		const dir = postgresProject({})
		for (const flag of [["--file", "x.sql"], ["--local"]]) {
			const io = makeIo(dir, pgAtlas([]))
			expect(await runCli(["migrate", "apply", "core", ...flag], io)).toBe(1)
			expect(io.errors[0]).toContain(`${flag[0]} does not apply to a Postgres database`)
		}
	})

	/* M1: only D1's history records names apart from hashes */
	it("refuses baseline --hashes, as Atlas records each file's hash in its revisions", async () => {
		const io = makeIo(postgresProject({}), pgAtlas([]))
		expect(await runCli(["migrate", "baseline", "core", "--hashes"], io)).toBe(1)
		expect(io.errors).toEqual([
			"--hashes is for a D1 database, whose history records names alone: Atlas records each file's hash as it applies it",
		])
	})

	it("refuses a migrations directory that does not exist", async () => {
		const dir = postgresProject({})
		const io = makeIo(dir, pgAtlas([]))
		expect(await runCli(["migrate", "apply", "core", "--dir", "nowhere"], io)).toBe(1)
		expect(io.errors).toEqual([`Migrations dir not found: ${join(dir, "nowhere")}`])
	})

	it("warns of a URL that may send the password unprotected", async () => {
		const dir = postgresProject({}, "postgres://app:pw@db.example.com/app")
		const io = makeIo(dir, pgAtlas([]))
		expect(await runCli(["migrate", "apply", "core"], io)).toBe(0)
		expect(io.errors).toEqual([
			expect.stringContaining("Warning: url reaches db.example.com without sslmode=verify-full or require"),
		])
	})
})

describe("migrate status", () => {
	it("lists a Postgres database's applied and pending migrations", async () => {
		const dir = postgresProject({ "1_init.sql": "SELECT 1;\n" })
		const io = makeIo(dir, pgAtlas(["1_init.sql"]))
		expect(await runCli(["migrate", "status", "core"], io)).toBe(0)
		expect(io.outputs).toEqual(["Applied: 0", "Pending: 1_init.sql"])
	})
})

describe("migrate apply, check and status --json on Postgres (C5)", () => {
	it("prints one JSON object as the only stdout, for each mode", async () => {
		const dir = postgresProject({ "1_init.sql": 'CREATE TABLE "post" ("id" integer);\n' })
		const run = async (mode: string) => {
			const io = makeIo(dir, pgAtlas(["1_init.sql"]))
			expect(await runCli(["migrate", mode, "core", "--json"], io)).toBe(0)
			expect(io.outputs).toHaveLength(1)
			return JSON.parse(io.outputs[0] as string) as unknown
		}
		expect(await run("status")).toEqual({ applied: [], database: "core", pending: ["1_init.sql"], refused: [] })
		expect(await run("check")).toEqual({ applied: [], database: "core", pending: ["1_init.sql"], refused: [] })
		expect(await run("apply")).toEqual({ applied: ["1_init.sql"], database: "core", pending: [], refused: [] })
	})
})
