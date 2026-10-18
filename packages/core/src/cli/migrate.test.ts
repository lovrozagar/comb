import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Run } from "../migrate/core/process.ts"
import { makeIo, ok, projects, writeTables } from "./__fixtures__/io.ts"
import { help, runCli } from "./run.ts"

const temp = projects()
const project = temp.make
afterEach(temp.clean)

const dirArg = (args: readonly string[]) => (args[args.indexOf("--dir") + 1] as string).replace("file://", "")

/**
 * Atlas as the migrate commands drive it: `migrate hash` writes atlas.sum from the directory's
 * files, `migrate diff` hands the directory it replays to `diff`; drizzle-kit exports SCHEMA.
 */
function fakeAtlas(diff: (dir: string) => void): Run & { calls: string[][] } {
	const calls: string[][] = []
	const run: Run = (cmd, args) => {
		calls.push([cmd, ...args])
		if (cmd === "bun") return ok("CREATE TABLE post (id TEXT PRIMARY KEY);")
		if (args[0] === "version") return ok("atlas version v1.3.0")
		const dir = dirArg(args)
		if (args[1] === "hash") {
			writeFileSync(
				join(dir, "atlas.sum"),
				readdirSync(dir)
					.filter((f) => f.endsWith(".sql"))
					.sort()
					.join("\n"),
			)
			return ok()
		}
		diff(dir)
		return ok()
	}
	return Object.assign(run, { calls })
}

describe("comb migrate", () => {
	it("prints the help without a subcommand", async () => {
		for (const argv of [["migrate"], ["migrate", "help"], ["migrate", "--help"]]) {
			const io = makeIo(project())
			expect(await runCli(argv, io)).toBe(0)
			expect(io.outputs).toEqual([help()])
		}
	})

	it("hands apply and baseline on, with their own usage", async () => {
		const io = makeIo(project())
		expect(await runCli(["migrate", "baseline"], io)).toBe(1)
		expect(io.errors).toEqual(["Usage: comb migrate baseline <database> [-e <env>] [--dir <path>] [--local]"])
	})

	it("returns 0 once apply or baseline is done", async () => {
		const dir = project()
		mkdirSync(join(dir, "m"))
		writeFileSync(
			join(dir, "comb.migrate.config.ts"),
			`export default { databases: { core: { migrationsDir: "./m", name: "core", provider: { type: "libsql", url: ${JSON.stringify(`file:${join(dir, "core.db")}`)} } } } }\n`,
		)
		const io = makeIo(dir)
		expect(await runCli(["migrate", "baseline", "core"], io)).toBe(0)
		expect(io.outputs).toEqual(["\nBaseline done: 0 marked, 0 already tracked"])
		const applied = makeIo(dir)
		expect(await runCli(["migrate", "apply", "core"], applied)).toBe(0)
		expect(applied.outputs).toEqual(["\nDone: 0 applied, 0 skipped"])
	})

	it("rejects an unknown migrate command", async () => {
		const io = makeIo(project())
		expect(await runCli(["migrate", "nope"], io)).toBe(1)
		expect(io.errors).toEqual(["Unknown migrate command: nope"])
	})

	it("creates the migrate init files in cwd", async () => {
		const dir = project()
		const io = makeIo(dir)
		expect(await runCli(["migrate", "init"], io)).toBe(0)
		expect(io.outputs).toEqual(["Created: drizzle.config.ts", "Created: atlas.hcl", "Created: atlas-migrations/"])
		expect(readFileSync(join(dir, "atlas.hcl"), "utf8")).toContain('dev = "sqlite://file?mode=memory"')
		const again = makeIo(dir)
		expect(await runCli(["migrate", "init"], again)).toBe(0)
		expect(again.outputs).toEqual([])
	})
})

describe("comb migrate diff", () => {
	it("asks the injected runner for atlas before diffing", async () => {
		const calls: string[][] = []
		const run: Run = (cmd, args) => {
			calls.push([cmd, ...args])
			return { code: 127, stderr: "atlas: command not found", stdout: "" }
		}
		const io = makeIo(project(), run)
		expect(await runCli(["migrate", "diff", "core"], io)).toBe(1)
		expect(io.errors).toEqual(["Atlas not found. Install: https://atlasgo.io/getting-started"])
		expect(calls).toEqual([["atlas", "version"]])
	})

	it("writes the migration Atlas generates, under the name given", async () => {
		const dir = project()
		const run = fakeAtlas((replayed) =>
			writeFileSync(join(replayed, "20260101000000_init.sql"), "CREATE TABLE post (id TEXT PRIMARY KEY);\n"),
		)
		const io = makeIo(dir, run)
		expect(await runCli(["migrate", "diff", "core", "init"], io)).toBe(0)
		expect(io.outputs).toEqual([`Generated: ${join(dir, "atlas-migrations", "20260101000000_init.sql")}`])
		expect(run.calls.find((call) => call[2] === "diff")?.[3]).toBe("init")
	})

	it("says when the schema is already in sync", async () => {
		const io = makeIo(
			project(),
			fakeAtlas(() => undefined),
		)
		expect(await runCli(["migrate", "diff"], io)).toBe(0)
		expect(io.outputs).toEqual(["Schema is already in sync — no migration needed"])
	})
})

describe("comb migrate diff: the config it reads", () => {
	it("fails migrate diff when the config's FTS cannot be read, instead of diffing without it (S-12)", async () => {
		const dir = project()
		writeFileSync(
			join(dir, "comb.config.ts"),
			'export default { databases: { core: { fts: { post: { columns: ["title"] } }, tables: "./missing.tables.ts" } } }\n',
		)
		const io = makeIo(
			dir,
			fakeAtlas(() => undefined),
		)
		expect(await runCli(["migrate", "diff", "core"], io)).toBe(1)
		expect(io.errors.join("\n")).toMatch(/missing\.tables\.ts/)
	})

	it("refuses migrate diff for a database the config does not declare", async () => {
		const dir = project()
		writeTables(dir)
		writeFileSync(
			join(dir, "comb.config.ts"),
			'export default { databases: { core: { tables: "./db.core.tables.ts" } } }\n',
		)
		const io = makeIo(
			dir,
			fakeAtlas(() => undefined),
		)
		expect(await runCli(["migrate", "diff", "nope"], io)).toBe(1)
		expect(io.errors.join("\n")).toContain('comb.config.ts declares no database "nope"')
	})
})

describe("comb migrate diff: through comb.migrate.config.ts", () => {
	it("writes into the database's configured migrations directory, relative to the config", async () => {
		const dir = project()
		mkdirSync(join(dir, "db", "m"), { recursive: true })
		writeFileSync(
			join(dir, "comb.migrate.config.ts"),
			'export default { databases: { core: { migrationsDir: "db/m", name: "core", provider: { type: "libsql", url: "file:core.db" } } } }\n',
		)
		const run = fakeAtlas((replayed) =>
			writeFileSync(join(replayed, "1_init.sql"), "CREATE TABLE post (id TEXT PRIMARY KEY);\n"),
		)
		const io = makeIo(dir, run)
		expect(await runCli(["migrate", "diff", "core", "init"], io)).toBe(0)
		expect(io.outputs).toEqual([`Generated: ${join(dir, "db", "m", "1_init.sql")}`])
	})

	it("diffs a Postgres database with its drizzle config, scoped to its schema, its dev URL in the environment", async () => {
		const dir = project()
		writeFileSync(
			join(dir, "comb.migrate.config.ts"),
			'export default { databases: { core: { drizzleConfigPath: "drizzle.pg.ts", migrationsDir: "pg", name: "core", provider: { devUrl: "postgres://dev:pw@localhost/dev", schema: "app", type: "postgres", url: "postgres://localhost/app" } } } }\n',
		)
		const envs: Array<Readonly<Record<string, string | undefined>> | undefined> = []
		const atlas = fakeAtlas((replayed) =>
			writeFileSync(join(replayed, "1_init.sql"), 'CREATE TABLE "post" ("id" integer);\n'),
		)
		const run: Run = (cmd, args, options) => (envs.push(options?.env), atlas(cmd, args, options))
		const io = makeIo(dir, run)
		expect(await runCli(["migrate", "diff", "core", "init"], io)).toBe(0)
		expect(io.outputs).toEqual([`Generated: ${join(dir, "pg", "1_init.sql")}`])
		expect(atlas.calls.find((call) => call[0] === "bun")).toEqual([
			"bun",
			"drizzle-kit",
			"export",
			"--config",
			join(dir, "drizzle.pg.ts"),
		])
		const diffAt = atlas.calls.findIndex((call) => call[2] === "diff")
		expect(atlas.calls[diffAt]?.join(" ")).not.toContain("pw")
		expect(envs[diffAt]?.["COMB_ATLAS_DEV_URL"]).toBe("postgres://dev:pw@localhost/dev?search_path=app")
	})
})
