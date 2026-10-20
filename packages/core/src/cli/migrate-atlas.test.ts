import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Run } from "../migrate/core/process.ts"
import { makeIo, ok, projects } from "./__fixtures__/io.ts"
import { runCli } from "./run.ts"

const temp = projects()
const project = temp.make
afterEach(temp.clean)

/** Atlas on a Postgres database: hash sums file names, status lists `pending`, apply applies them, set records */
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
		if (args[0] === "schema") return ok("Schemas are synced, no changes to be made.\n")
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

	it("refuses --file and --local, which Atlas has no use for", async () => {
		const dir = postgresProject({})
		for (const flag of [["--file", "x.sql"], ["--local"]]) {
			const io = makeIo(dir, pgAtlas([]))
			expect(await runCli(["migrate", "apply", "core", ...flag], io)).toBe(1)
			expect(io.errors[0]).toContain(`${flag[0]} does not apply to a Postgres database`)
		}
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
