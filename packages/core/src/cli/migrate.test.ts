import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ATLAS_RANGE, type Run, type RunResult } from "../migrate/core/process.ts"
import { fakeAtlas as hashingAtlas, writeSum } from "./__fixtures__/d1.ts"
import { makeIo, projects, runCliWithFakes, writeTables } from "./__fixtures__/io.ts"
import { diffProject, fakeAtlas } from "./__fixtures__/diff.ts"
import { help } from "./run.ts"
import { onBun } from "../../tests/support/runtime.ts"
import { fixtureRoot } from "../codegen/__fixtures__/temp.ts"

const temp = projects()
const project = temp.make
afterEach(temp.clean)

describe("comb migrate", () => {
	it("prints the help for help or --help, and refuses no subcommand with it", async () => {
		const bare = makeIo(project())
		expect(await runCliWithFakes(["migrate"], bare)).toBe(1)
		expect(bare.errors).toEqual([help()])
		for (const argv of [
			["migrate", "help"],
			["migrate", "--help"],
			["migrate", "-h"],
		]) {
			const io = makeIo(project())
			expect(await runCliWithFakes(argv, io)).toBe(0)
			expect(io.outputs).toEqual([help()])
		}
	})

	it("hands apply and baseline on, with their own usage", async () => {
		const io = makeIo(project())
		expect(await runCliWithFakes(["migrate", "baseline"], io)).toBe(1)
		expect(io.errors).toEqual([
			"Usage: comb migrate baseline <database> [-e <name>] [--dir <path>] [--local] [--hashes]",
		])
	})

	it("returns 0 once apply or baseline is done", async () => {
		const dir = project()
		mkdirSync(join(dir, "m"))
		writeFileSync(
			join(dir, "comb.migrate.config.ts"),
			`export default { databases: { core: { migrationsDir: "./m", name: "core", provider: { type: "libsql", url: ${JSON.stringify(`file:${join(dir, "core.db")}`)} } } } }\n`,
		)
		writeSum(join(dir, "m"))
		const io = makeIo(dir, hashingAtlas())
		expect(await runCliWithFakes(["migrate", "baseline", "core"], io)).toBe(0)
		expect(io.outputs).toEqual(["\nBaseline done: 0 marked, 0 already tracked"])
		const applied = makeIo(dir, hashingAtlas())
		expect(await runCliWithFakes(["migrate", "apply", "core"], applied)).toBe(0)
		expect(applied.outputs).toEqual(["\nDone: 0 applied, 0 skipped"])
	})

	it("rejects an unknown migrate command", async () => {
		const io = makeIo(project())
		expect(await runCliWithFakes(["migrate", "nope"], io)).toBe(1)
		expect(io.errors).toEqual(["Unknown migrate command: nope"])
	})
})

describe("comb migrate init", () => {
	it("creates the migrate init files in cwd", async () => {
		const dir = project()
		const io = makeIo(dir)
		expect(await runCliWithFakes(["migrate", "init"], io)).toBe(0)
		/* no atlas.hcl: comb runs Atlas with a config of its own, so a scaffolded one would promise a guard nothing reads (C11) */
		expect(io.outputs).toEqual(["Created: drizzle.config.ts", "Created: atlas-migrations/"])
		expect(existsSync(join(dir, "atlas.hcl"))).toBe(false)
		const again = makeIo(dir)
		expect(await runCliWithFakes(["migrate", "init"], again)).toBe(0)
		expect(again.outputs).toEqual([])
	})

	it("creates a Postgres project with --dialect postgres: no credential in any file, and no atlas.hcl", async () => {
		const dir = project()
		const io = makeIo(dir)
		expect(await runCliWithFakes(["migrate", "init", "--dialect", "postgres"], io)).toBe(0)
		expect(io.outputs).toEqual([
			"Created: drizzle.config.ts",
			"Created: comb.migrate.config.ts",
			"Created: atlas-migrations/",
		])
		const read = (name: string) => readFileSync(join(dir, name), "utf8")
		expect(read("drizzle.config.ts")).toContain('dialect: "postgresql"')
		expect(read("drizzle.config.ts")).not.toContain("dbCredentials")
		expect(read("comb.migrate.config.ts")).toContain('type: "postgres"')
		expect(read("comb.migrate.config.ts")).toContain('url: process.env["DATABASE_URL"] ?? ""')
		expect(existsSync(join(dir, "atlas.hcl"))).toBe(false)
		for (const name of ["drizzle.config.ts", "comb.migrate.config.ts"])
			expect(read(name)).not.toMatch(/:\/\/[^\s"]*:[^\s"]*@/)
	})

	it("keeps the files a project has, and refuses a dialect it does not know", async () => {
		const dir = project()
		writeFileSync(join(dir, "comb.migrate.config.ts"), "export default {}\n")
		const io = makeIo(dir)
		expect(await runCliWithFakes(["migrate", "init", "--dialect", "postgres"], io)).toBe(0)
		expect(io.outputs).not.toContain("Created: comb.migrate.config.ts")
		expect(readFileSync(join(dir, "comb.migrate.config.ts"), "utf8")).toBe("export default {}\n")
		const unknown = makeIo(dir)
		expect(await runCliWithFakes(["migrate", "init", "--dialect", "mysql"], unknown)).toBe(1)
		expect(unknown.errors).toEqual(['Unknown --dialect "mysql": use sqlite or postgres'])
	})
})

describe("comb migrate diff", () => {
	/* KC6 of r22: a missing Atlas is refused as a peer, by the one version read, with no probe of diff's own */
	it("reads Atlas's version through the injected runner, and refuses a missing one as a peer before diffing", async () => {
		const calls: string[][] = []
		const run: Run = (cmd, args) => {
			calls.push([cmd, ...args])
			return { code: 127, stderr: "atlas: command not found", stdout: "" }
		}
		const dir = project()
		/* a diff refuses a project without a drizzle config first, which reads a file and starts nothing */
		writeFileSync(join(dir, "drizzle.config.ts"), 'export default { dialect: "sqlite" }\n')
		const io = { ...makeIo(dir, run), readAtlasVersion: undefined }
		expect(await runCliWithFakes(["migrate", "diff", "core"], io)).toBe(1)
		expect(io.errors).toEqual([
			`comb needs atlas (${ATLAS_RANGE}) to hash, diff and apply migrations; install atlas from https://atlasgo.io/getting-started`,
		])
		expect(calls).toEqual([["atlas", "version"]])
	})

	/* K21 of the 0.15.0 review: drizzle-kit's own lookup named a drizzle.config.json init never writes */
	it("refuses a project with no drizzle config before drizzle-kit runs, and one whose configured file is missing", async () => {
		const dir = project()
		const bare = makeIo(
			dir,
			fakeAtlas(() => undefined),
		)
		expect(await runCliWithFakes(["migrate", "diff", "core"], bare)).toBe(1)
		expect(bare.errors).toEqual([
			`no drizzle config in ${dir} (drizzle.config.ts, .js, .mjs or .json): run comb migrate init, or set drizzleConfigPath on the database in comb.migrate.config.ts`,
		])
		writeFileSync(
			join(dir, "comb.migrate.config.ts"),
			'export default { databases: { core: { migrationsDir: "./m", drizzleConfigPath: "./gone.ts", name: "core", provider: { type: "libsql", url: "file:x.db" } } } }\n',
		)
		const missing = makeIo(
			dir,
			fakeAtlas(() => undefined),
		)
		expect(await runCliWithFakes(["migrate", "diff", "core"], missing)).toBe(1)
		expect(missing.errors).toEqual([`drizzleConfigPath ${join(dir, "gone.ts")} does not exist`])
	})

	it("writes the migration Atlas generates, under the name given", async () => {
		const dir = diffProject(project)
		const run = fakeAtlas((replayed) =>
			writeFileSync(join(replayed, "20260101000000_init.sql"), "CREATE TABLE post (id TEXT PRIMARY KEY);\n"),
		)
		const io = makeIo(dir, run)
		expect(await runCliWithFakes(["migrate", "diff", "core", "init"], io)).toBe(0)
		expect(io.outputs).toEqual([`Generated: ${join(dir, "atlas-migrations", "20260101000000_init.sql")}`])
		expect(run.calls.find((call) => call[2] === "diff")?.[3]).toBe("init")
	})
})

describe("comb migrate diff on a configured drizzle config", () => {
	/* r18 S5: a directory exists too, and drizzle-kit fails on it with words that name no field */
	it("refuses a configured drizzleConfigPath that is a directory", async () => {
		const dir = diffProject(project)
		writeFileSync(
			join(dir, "comb.migrate.config.ts"),
			'export default { databases: { core: { migrationsDir: "./m", drizzleConfigPath: ".", name: "core", provider: { type: "libsql", url: "file:x.db" } } } }\n',
		)
		const folder = makeIo(
			dir,
			fakeAtlas(() => undefined),
		)
		expect(await runCliWithFakes(["migrate", "diff", "core"], folder)).toBe(1)
		expect(folder.errors).toEqual([`drizzleConfigPath ${dir} is a directory, not a drizzle config`])
	})
})

/* plan 14's 5.4: Atlas OSS leaves out the triggers, functions and procedures a schema holds, and says so on stderr */
describe("comb migrate diff: what Atlas says as it succeeds", () => {
	const SKIPPED =
		"Skipped triggers, functions, stored procedures, and other advanced objects. Atlas Pro includes them in the diff."

	it("is a warning, whether Atlas wrote a migration or found the schema in sync", async () => {
		const dir = diffProject(project)
		const wrote = makeIo(
			dir,
			fakeAtlas((replayed) => {
				writeFileSync(join(replayed, "20260101000000_init.sql"), "CREATE TABLE post (id TEXT PRIMARY KEY);\n")
				return { code: 0, stderr: `${SKIPPED}\n`, stdout: "" }
			}),
		)
		expect(await runCliWithFakes(["migrate", "diff", "core", "init"], wrote)).toBe(0)
		expect(wrote.errors).toEqual([`Warning: Atlas: ${SKIPPED}`])
		const synced = makeIo(
			dir,
			fakeAtlas(() => ({ code: 0, stderr: SKIPPED, stdout: "" })),
		)
		expect(await runCliWithFakes(["migrate", "diff", "core", "--dry-run"], synced)).toBe(0)
		expect(synced.outputs).toEqual(["Schema is already in sync — no migration needed"])
		expect(synced.errors).toEqual([`Warning: Atlas: ${SKIPPED}`])
	})
})

describe("comb migrate diff: its options", () => {
	/* AD7 of the area D review: an option is refused, never dropped (P17 of r18), as status refuses this one */
	it("refuses -e with no comb.migrate.config.ts to define it, running nothing", async () => {
		const atlas = fakeAtlas(() => undefined)
		const io = makeIo(diffProject(project), atlas)
		expect(await runCliWithFakes(["migrate", "diff", "core", "-e", "prod"], io)).toBe(1)
		expect(io.errors).toEqual(["-e/--env needs comb.migrate.config.ts to define environments"])
		expect(atlas.calls).toEqual([])
	})
})

describe("comb migrate diff: the config it reads", () => {
	it("fails migrate diff when the config's FTS cannot be read, instead of diffing without it (S-12)", async () => {
		const dir = diffProject(project)
		writeFileSync(
			join(dir, "comb.config.ts"),
			'export default { databases: { core: { fts: { post: { columns: ["title"] } }, tables: "./missing.tables.ts" } } }\n',
		)
		const io = makeIo(
			dir,
			fakeAtlas(() => undefined),
		)
		expect(await runCliWithFakes(["migrate", "diff", "core"], io)).toBe(1)
		expect(io.errors.join("\n")).toMatch(/missing\.tables\.ts/)
	})

	/* D4-1 of the area D round-four review: inside the package, so the tables file imports drizzle and comb */
	it("diffs a database with a declared FTS, writing its FTS5 table into the generated file", async () => {
		const local = projects(fixtureRoot())
		try {
			const dir = diffProject(local.make)
			writeTables(dir)
			mkdirSync(join(dir, "atlas-migrations"))
			writeFileSync(
				join(dir, "comb.config.ts"),
				'export default { databases: { core: { tables: "./db.core.tables.ts", fts: { post: { columns: ["title"] } } } } }\n',
			)
			const io = makeIo(
				dir,
				fakeAtlas(() => undefined),
			)
			expect(await runCliWithFakes(["migrate", "diff", "core", "init"], io)).toBe(0)
			const written = readdirSync(join(dir, "atlas-migrations")).filter((file) => file.endsWith(".sql"))
			expect(written).toEqual([expect.stringMatching(/^\d{14}_init\.sql$/)])
			expect(io.outputs).toEqual([`Generated: ${join(dir, "atlas-migrations", written[0] as string)}`])
			expect(readFileSync(join(dir, "atlas-migrations", written[0] as string), "utf8")).toMatch(
				/CREATE VIRTUAL TABLE .*post_fts.* USING fts5/,
			)
		} finally {
			local.clean()
		}
	})

	it("refuses migrate diff for a database the config does not declare", async () => {
		const dir = diffProject(project)
		writeTables(dir)
		writeFileSync(
			join(dir, "comb.config.ts"),
			'export default { databases: { core: { tables: "./db.core.tables.ts" } } }\n',
		)
		const io = makeIo(
			dir,
			fakeAtlas(() => undefined),
		)
		expect(await runCliWithFakes(["migrate", "diff", "nope"], io)).toBe(1)
		expect(io.errors.join("\n")).toContain('comb.config.ts declares no database "nope"')
	})
})

describe("comb migrate diff: through comb.migrate.config.ts", () => {
	it("writes into the database's configured migrations directory, relative to the config", async () => {
		const dir = diffProject(project)
		mkdirSync(join(dir, "db", "m"), { recursive: true })
		writeFileSync(
			join(dir, "comb.migrate.config.ts"),
			'export default { databases: { core: { migrationsDir: "db/m", name: "core", provider: { type: "libsql", url: "file:core.db" } } } }\n',
		)
		const run = fakeAtlas((replayed) =>
			writeFileSync(join(replayed, "1_init.sql"), "CREATE TABLE post (id TEXT PRIMARY KEY);\n"),
		)
		const io = makeIo(dir, run)
		expect(await runCliWithFakes(["migrate", "diff", "core", "init"], io)).toBe(0)
		expect(io.outputs).toEqual([`Generated: ${join(dir, "db", "m", "1_init.sql")}`])
	})
})

describe("comb migrate diff: a Postgres database through comb.migrate.config.ts", () => {
	it("diffs a Postgres database with its drizzle config, scoped to its schema, its dev URL in the environment", async () => {
		const dir = diffProject(project)
		writeFileSync(join(dir, "drizzle.pg.ts"), 'export default { dialect: "postgresql" }\n')
		writeFileSync(
			join(dir, "comb.migrate.config.ts"),
			'export default { databases: { core: { drizzleConfigPath: "drizzle.pg.ts", migrationsDir: "pg", name: "core", provider: { devUrl: "postgres://dev:Dev-Secret-0451@localhost/dev", schema: "app", type: "postgres", url: "postgres://localhost/app" } } } }\n',
		)
		const envs: Array<Readonly<Record<string, string | undefined>> | undefined> = []
		const atlas = fakeAtlas((replayed) =>
			writeFileSync(join(replayed, "1_init.sql"), 'CREATE TABLE "post" ("id" integer);\n'),
		)
		const run: Run = (cmd, args, options) => (envs.push(options?.env), atlas(cmd, args, options))
		const io = makeIo(dir, run)
		expect(await runCliWithFakes(["migrate", "diff", "core", "init"], io)).toBe(0)
		expect(io.outputs).toEqual([`Generated: ${join(dir, "pg", "1_init.sql")}`])
		/* the drizzle-kit the command checked (K1 of r22), its bin on the runtime running comb (AD5): comb's own here, as io.locatePeer finds it */
		expect(atlas.calls.find((call) => call[0] === process.execPath)).toEqual([
			process.execPath,
			expect.stringMatching(/\/drizzle-kit\/bin\.cjs$/),
			"export",
			"--config",
			join(dir, "drizzle.pg.ts"),
		])
		const diffAt = atlas.calls.findIndex((call) => call[2] === "diff")
		expect(atlas.calls[diffAt]?.join(" ")).not.toContain("Dev-Secret-0451")
		expect(envs[diffAt]?.["COMB_ATLAS_DEV_URL"]).toBe("postgres://dev:Dev-Secret-0451@localhost/dev?search_path=app")
	})

	/* M75: a Postgres diff reads its history and the export with Postgres's parser, so it loads it first */
	it("loads the Postgres parser itself before it reads a Postgres diff", async () => {
		const dir = project()
		writeFileSync(join(dir, "drizzle.config.ts"), 'export default { dialect: "postgresql" }\n')
		writeFileSync(
			join(dir, "comb.migrate.config.ts"),
			'export default { databases: { core: { migrationsDir: "pg", name: "core", provider: { devUrl: "postgres://localhost/dev", type: "postgres", url: "postgres://localhost/app" } } } }\n',
		)
		const atlas = fakeAtlas((replayed) =>
			writeFileSync(join(replayed, "1_init.sql"), 'CREATE TABLE "post" ("id" integer);\n'),
		)
		/* a fresh module graph: the setup file loaded the parser in the one the other tests share */
		vi.resetModules()
		const fresh = await import("./run.ts")
		const io = makeIo(dir, atlas)
		expect(await fresh.runCliWith(["migrate", "diff", "core", "init"], io, io)).toBe(0)
		expect(io.outputs).toEqual([`Generated: ${join(dir, "pg", "1_init.sql")}`])
	})
})

/** A comb.migrate.config.ts declaring shard-0, with `codegen` written into its entry */
const MIGRATE = (codegen: string) =>
	`export default { databases: { "shard-0": { migrationsDir: "m", name: "shard-0", ${codegen}provider: { type: "libsql", url: "file:s0.db" } } } }\n`

describe("comb migrate diff: the name apply and check take (C7)", () => {
	it("takes a migrate name and reads FTS from the comb.config.ts database it maps to", async () => {
		const dir = diffProject(project)
		mkdirSync(join(dir, "m"), { recursive: true })
		writeFileSync(join(dir, "comb.migrate.config.ts"), MIGRATE('codegen: "shard", '))
		writeFileSync(
			join(dir, "comb.config.ts"),
			'export default { databases: { shard: { fts: { post: { columns: ["title"] } }, tables: "./missing.tables.ts" } } }\n',
		)
		const io = makeIo(
			dir,
			fakeAtlas(() => undefined),
		)
		expect(await runCliWithFakes(["migrate", "diff", "shard-0"], io)).toBe(1)
		/* the FTS lookup reached shard's tables file: the mapping held */
		expect(io.errors.join("\n")).toMatch(/missing\.tables\.ts/)
	})

	it("says how to map a migrate name comb.config.ts does not declare", async () => {
		const dir = diffProject(project)
		mkdirSync(join(dir, "m"), { recursive: true })
		writeFileSync(join(dir, "comb.migrate.config.ts"), MIGRATE(""))
		writeFileSync(
			join(dir, "comb.config.ts"),
			'export default { databases: { shard: { tables: "./db.core.tables.ts" } } }\n',
		)
		const io = makeIo(
			dir,
			fakeAtlas(() => undefined),
		)
		expect(await runCliWithFakes(["migrate", "diff", "shard-0"], io)).toBe(1)
		expect(io.errors.join("\n")).toContain(
			'comb.config.ts declares no database "shard-0". Available: shard. Set codegen: "<its comb.config.ts name>" on shard-0 in comb.migrate.config.ts',
		)
	})
})

/* S4, C8 of the 0.14.1 review: a D1 diff writes beside files wrangler would run otherwise than Atlas */
describe("comb migrate diff on a D1 database", () => {
	it.each([
		[{ ".2_b.sql": "CREATE TABLE b (id TEXT);" }, ".2_b.sql starts with a dot"],
		[{ "9_b.sql": "CREATE TABLE b (id TEXT);", "10_c.sql": "CREATE TABLE c (id TEXT);" }, "10_c.sql runs after"],
	])("refuses a directory wrangler lists otherwise than Atlas, writing nothing", async (extra, message) => {
		const dir = diffProject(project)
		mkdirSync(join(dir, "m"), { recursive: true })
		for (const [name, sql] of Object.entries({ "1_init.sql": "CREATE TABLE a (id TEXT);", ...extra }))
			writeFileSync(join(dir, "m", name), sql)
		writeSum(join(dir, "m"))
		writeFileSync(
			join(dir, "comb.migrate.config.ts"),
			'export default { databases: { core: { migrationsDir: "m", name: "core", provider: { type: "d1", databaseName: "core", wranglerConfig: "wrangler.toml" } } } }\n',
		)
		const before = readdirSync(join(dir, "m")).toSorted()
		const io = makeIo(
			dir,
			fakeAtlas(() => undefined),
		)
		expect(await runCliWithFakes(["migrate", "diff", "core", "next"], io)).toBe(1)
		expect(io.errors[0]).toContain(message)
		expect(readdirSync(join(dir, "m")).toSorted()).toEqual(before)
	})
})

/* D2-14 of the area D round-two review: drizzle-kit runs on comb's runtime, and on Node it cannot load a JSON config */
describe("comb migrate diff: a drizzle.config.json", () => {
	/* D3-5 of the area D round-three review: the refusal sits in exportWith, after the peers are checked (Atlas's version read once) */
	it("is refused on Node after the peers are checked and before drizzle-kit runs, naming the .ts to write instead, and diffs on Bun", async () => {
		const dir = project()
		const file = join(dir, "drizzle.config.json")
		writeFileSync(file, '{ "dialect": "sqlite" }\n')
		await onBun(undefined, async () => {
			const run = fakeAtlas(() => undefined)
			const base = makeIo(dir, run)
			let versionReads = 0
			const readAtlasVersion = base.readAtlasVersion as () => RunResult
			const io = {
				...base,
				readAtlasVersion: () => {
					versionReads++
					return readAtlasVersion()
				},
			}
			expect(await runCliWithFakes(["migrate", "diff", "core"], io)).toBe(1)
			expect({ calls: run.calls, errors: io.errors, versionReads }).toEqual({
				calls: [],
				versionReads: 1,
				errors: [
					`${file} is JSON, which drizzle-kit cannot load when comb runs on Node: write it as drizzle.config.ts, export default the same object, or run comb on Bun`,
				],
			})
		})
		await onBun("1.3.0", async () => {
			const io = makeIo(
				dir,
				fakeAtlas(() => undefined),
			)
			expect(await runCliWithFakes(["migrate", "diff", "core"], io)).toBe(0)
			expect(io.outputs).toEqual(["Schema is already in sync — no migration needed"])
		})
	})
})
