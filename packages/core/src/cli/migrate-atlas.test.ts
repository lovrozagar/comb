import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ATLAS_RANGE, type Run, run as runProcess } from "../migrate/core/process.ts"
import { makeIo, ok, projects, runCliWithFakes } from "./__fixtures__/io.ts"
import { UNCOMPARED } from "../migrate/core/baseline-compare.ts"

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
	devUrl?: string,
): string {
	const dir = project()
	mkdirSync(join(dir, "pg"))
	for (const [name, sql] of Object.entries(migrations)) writeFileSync(join(dir, "pg", name), sql)
	pgAtlas([])("atlas", ["migrate", "hash", "--dir", `file://${join(dir, "pg")}`])
	writeFileSync(
		join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./pg", name: "core", provider: { type: "postgres", url: ${JSON.stringify(url)}${devUrl === undefined ? "" : `, devUrl: ${JSON.stringify(devUrl)}`} } } } }\n`,
	)
	return dir
}

/* KC7 of r22b: a blank url said only "url is empty", which init's starter gives whenever DATABASE_URL is unset */
describe("a Postgres database with a blank url", () => {
	it("is refused naming the database, and where init's starter reads it, before Atlas runs", async () => {
		const dir = postgresProject({}, " ")
		for (const mode of ["status", "check", "apply"]) {
			const atlas = pgAtlas([])
			const io = makeIo(dir, atlas)
			expect(await runCliWithFakes(["migrate", mode, "core"], io)).toBe(1)
			expect(io.errors).toEqual([
				"url is empty: set the postgres provider's url for core (core); init's starter reads it from DATABASE_URL",
			])
			expect(atlas.calls.filter((call) => call[0] !== "version")).toEqual([])
		}
	})
})

/* AD9 of the area D review: a blank devUrl said only "devUrl is empty", whose database unnamed */
describe("a Postgres database with a blank devUrl", () => {
	it("is refused naming the database by each command that reaches it, before Atlas runs", async () => {
		const dir = postgresProject({}, undefined, " ")
		writeFileSync(join(dir, "drizzle.config.ts"), 'export default { dialect: "postgresql" }\n')
		for (const mode of ["diff", "check", "apply", "baseline"]) {
			const atlas = pgAtlas([])
			const io = makeIo(dir, atlas)
			expect(await runCliWithFakes(["migrate", mode, "core"], io)).toBe(1)
			expect(io.errors).toEqual(["devUrl is empty: set the postgres provider's devUrl for core (core)"])
			expect(atlas.calls.filter((call) => call[0] !== "version")).toEqual([])
		}
	})

	it("is left to status, which never reaches it", async () => {
		const io = makeIo(postgresProject({}, undefined, " "), pgAtlas([]))
		expect(await runCliWithFakes(["migrate", "status", "core"], io)).toBe(0)
	})
})

describe("migrate apply and baseline: a Postgres database, through Atlas", () => {
	it("applies the pending files through Atlas, the URL in its environment only", async () => {
		const dir = postgresProject({ "1_init.sql": 'CREATE TABLE "post" ("id" integer);\n' })
		const atlas = pgAtlas(["1_init.sql"])
		const io = makeIo(dir, atlas)
		expect(await runCliWithFakes(["migrate", "apply", "core"], io)).toBe(0)
		expect(io.outputs).toEqual(["Apply: 1_init.sql", "\nDone: 1 applied"])
		expect(atlas.calls.map((call) => call.join(" ")).join("\n")).not.toContain("pw@")
	})

	it("checks and approves the pending files with check, applying none", async () => {
		const dir = postgresProject({ "1_init.sql": 'CREATE TABLE "post" ("id" integer);\n' })
		const atlas = pgAtlas(["1_init.sql"])
		const io = makeIo(dir, atlas)
		expect(await runCliWithFakes(["migrate", "check", "core"], io)).toBe(0)
		/* the default devUrl is Atlas's own container, so check says it replayed nothing there (P13 of r19) */
		expect(io.outputs).toEqual([
			"Check did not replay the pending files on devUrl: docker://postgres/17/dev is Atlas's own container, which comb cannot reach, so a statement Postgres refuses on every database is found only when it applies; set devUrl to a postgres:// scratch database comb can connect to",
			"\nCheck passed: 1 pending: 1_init.sql",
		])
		expect(atlas.calls.some((call) => call[1] === "apply" && !call.includes("--dry-run"))).toBe(false)
	})

	it("asks before an unsafe file, and takes no --yes for it", async () => {
		const dir = postgresProject({ "1_drop.sql": 'DROP TABLE "post";\n' })
		const io = makeIo(dir, pgAtlas(["1_drop.sql"]))
		expect(await runCliWithFakes(["migrate", "apply", "core", "--yes"], io)).toBe(1)
		expect(io.errors[0]).toContain('1_drop.sql is unsafe (DROP TABLE "post");')
	})
})

describe("migrate baseline and its refusals: a Postgres database, through Atlas", () => {
	it("records every file with baseline, running none", async () => {
		const dir = postgresProject({ "1_init.sql": "SELECT 1;\n", "2_more.sql": "SELECT 2;\n" })
		const atlas = pgAtlas([])
		const io = makeIo(dir, atlas)
		expect(await runCliWithFakes(["migrate", "baseline", "core"], io)).toBe(0)
		expect(atlas.calls.find((call) => call[1] === "set")?.slice(0, 3)).toEqual(["migrate", "set", "2"])
		expect(io.outputs).toEqual([
			UNCOMPARED,
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
		expect(await fresh.runCliWith(["migrate", "baseline", "core"], io, io)).toBe(0)
		expect(io.outputs.at(-1)).toBe("\nBaseline done: 1 marked")
	})

	it("refuses --file and --local, which Atlas has no use for", async () => {
		const dir = postgresProject({})
		for (const flag of [["--file", "x.sql"], ["--local"]]) {
			const io = makeIo(dir, pgAtlas([]))
			expect(await runCliWithFakes(["migrate", "apply", "core", ...flag], io)).toBe(1)
			expect(io.errors[0]).toContain(`${flag[0]} does not apply to a Postgres database`)
		}
	})

	/* M1: only D1's history records names apart from hashes */
	it("refuses baseline --hashes, as Atlas records each file's hash in its revisions", async () => {
		const io = makeIo(postgresProject({}), pgAtlas([]))
		expect(await runCliWithFakes(["migrate", "baseline", "core", "--hashes"], io)).toBe(1)
		expect(io.errors).toEqual([
			"--hashes is for a D1 database, whose history records names alone: Atlas records each file's hash as it applies it",
		])
	})

	it("refuses a migrations directory that does not exist", async () => {
		const dir = postgresProject({})
		const io = makeIo(dir, pgAtlas([]))
		expect(await runCliWithFakes(["migrate", "apply", "core", "--dir", "nowhere"], io)).toBe(1)
		expect(io.errors).toEqual([`Migrations dir not found: ${join(dir, "nowhere")}`])
	})

	it("warns of a URL that may send the password unprotected", async () => {
		const dir = postgresProject({}, "postgres://app:pw@db.example.com/app?sslmode=prefer")
		const io = makeIo(dir, pgAtlas([]))
		expect(await runCliWithFakes(["migrate", "apply", "core"], io)).toBe(0)
		expect(io.errors).toEqual([
			expect.stringContaining("Warning: url reaches db.example.com without sslmode=verify-full or require"),
		])
	})
})

describe("migrate status", () => {
	it("lists a Postgres database's applied and pending migrations", async () => {
		const dir = postgresProject({ "1_init.sql": "SELECT 1;\n" })
		const io = makeIo(dir, pgAtlas(["1_init.sql"]))
		expect(await runCliWithFakes(["migrate", "status", "core"], io)).toBe(0)
		expect(io.outputs).toEqual(["Applied: 0", "Pending: 1_init.sql"])
	})
})

describe("migrate apply, check and status --json on Postgres (C5)", () => {
	it("prints one JSON object as the only stdout, for each mode", async () => {
		const dir = postgresProject({ "1_init.sql": 'CREATE TABLE "post" ("id" integer);\n' })
		const run = async (mode: string) => {
			const io = makeIo(dir, pgAtlas(["1_init.sql"]))
			expect(await runCliWithFakes(["migrate", mode, "core", "--json"], io)).toBe(0)
			expect(io.outputs).toHaveLength(1)
			return JSON.parse(io.outputs[0] as string) as unknown
		}
		expect(await run("status")).toEqual({
			applied: [],
			database: "core",
			pending: ["1_init.sql"],
			refused: [],
			unknown: [],
		})
		expect(await run("check")).toEqual({
			applied: [],
			database: "core",
			pending: ["1_init.sql"],
			refused: [],
			unknown: [],
		})
		expect(await run("apply")).toEqual({
			applied: ["1_init.sql"],
			database: "core",
			pending: [],
			refused: [],
			unknown: [],
		})
	})

	/* K6 of r21: a refusal quoting Atlas is one line, as every other entry, without Atlas's trailing newline */
	it("prints a refusal that quotes Atlas without Atlas's trailing newline", async () => {
		const dir = postgresProject({ "1_init.sql": "SELECT 1;\n" })
		const said = "Error: postgres: querying system variables: dial tcp 127.0.0.1:9: connect: connection refused\n"
		for (const mode of ["status", "check", "apply"]) {
			const atlas = pgAtlas([])
			const refused: Run = (cmd, args, options) =>
				args[1] === "status" ? { code: 1, stderr: said, stdout: "" } : atlas(cmd, args, options)
			const io = makeIo(dir, refused)
			expect(await runCliWithFakes(["migrate", mode, "core", "--json"], io)).toBe(1)
			expect((JSON.parse(io.outputs[0] as string) as { refused: string[] }).refused).toEqual([
				`atlas migrate status: ${said.trim()}`,
			])
		}
	})
})

/* KC6 + PA22 of r22: a missing Atlas is a peer the command lacks, said one way by every command */
describe("no Atlas on PATH: every Postgres command names it (KC6 + PA22; sibling: K3's PATH-free refusal)", () => {
	it("refuses diff, status, check, apply and baseline naming Atlas, its range and its install page, before any other call", async () => {
		const dir = postgresProject({ "1_init.sql": 'CREATE TABLE "post" ("id" integer);\n' })
		writeFileSync(join(dir, "drizzle.config.ts"), `export default { dialect: "postgresql", schema: "./x.ts" }\n`)
		for (const mode of ["diff", "status", "check", "apply", "baseline"]) {
			const calls: string[] = []
			/* comb's own runner, with a PATH that holds no atlas */
			const noAtlas: Run = (cmd, args, options) => {
				calls.push([cmd, ...args].join(" "))
				return runProcess(cmd, args, { ...options, env: { ...options?.env, PATH: "/nonexistent" } })
			}
			const io = { ...makeIo(dir, noAtlas), readAtlasVersion: undefined }
			expect(await runCliWithFakes(["migrate", mode, "core"], io)).toBe(1)
			const said = io.errors.join("\n")
			expect(said).toContain(`comb needs atlas (${ATLAS_RANGE}) to hash, diff and apply migrations`)
			expect(said).toContain("install atlas from https://atlasgo.io/getting-started")
			expect(said).not.toContain("atlas migrate hash failed")
			expect(calls).toEqual(["atlas version"])
		}
	})
})
