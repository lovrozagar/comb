import { createClient } from "@libsql/client"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { CliIo } from "./output.ts"
import { fakeAtlas, writeSum } from "./__fixtures__/d1.ts"
import { makeIo, projects } from "./__fixtures__/io.ts"
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
	writeSum(join(dir, "m"))
	writeFileSync(
		join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./m", name: "core-dev", provider: { type: "libsql", url: ${JSON.stringify(url)} } } } }\n`,
	)
	return { dir, url }
}

/** A CliIo in `dir` with atlas faked, answering `confirm` when given */
const io = (dir: string, confirm?: CliIo["confirm"]) => makeIo(dir, fakeAtlas(), confirm)

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

/** The database at `url` made, holding one table, `keep`, as an existing database would */
async function keepOnly(url: string): Promise<void> {
	const client = createClient({ url })
	await client.execute("CREATE TABLE keep (x)")
	client.close()
}

describe("migrate apply: arguments", () => {
	it("prints apply usage when the database name is missing, and a missing dir", async () => {
		const dir = project()
		const usage = io(dir)
		expect(await runCli(["migrate", "apply"], usage)).toBe(1)
		expect(usage.errors).toEqual([
			"Usage: comb migrate apply <database> [-e <name>] [--dir <path>] [--file <path>] [-y] [--local] [--json]",
		])
		const baseline = io(dir)
		expect(await runCli(["migrate", "baseline"], baseline)).toBe(1)
		expect(baseline.errors).toEqual([
			"Usage: comb migrate baseline <database> [-e <name>] [--dir <path>] [--local] [--hashes]",
		])
		const check = io(dir)
		expect(await runCli(["migrate", "check"], check)).toBe(1)
		expect(check.errors).toEqual([
			"Usage: comb migrate check <database> [-e <name>] [--dir <path>] [-y] [--local] [--json]",
		])
		const extra = io(dir)
		expect(await runCli(["migrate", "apply", "core", "blog"], extra)).toBe(1)
		const { dir: configuredDir } = configured({})
		const missing = io(configuredDir)
		expect(await runCli(["migrate", "baseline", "core", "--dir", "nowhere"], missing)).toBe(1)
		expect(missing.errors).toEqual([`Migrations dir not found: ${join(configuredDir, "nowhere")}`])
	})
})

describe("migrate apply: through comb.migrate.config.ts", () => {
	it("applies, then skips what it applied, and names the database it applied to", async () => {
		const { dir, url } = configured({ "1_init.sql": "CREATE TABLE post (id TEXT);" })
		const first = io(dir)
		expect(await runCli(["migrate", "apply", "core"], first)).toBe(0)
		/* a database with no tables and no history holds nothing to lose (C3) */
		expect(first.outputs).toEqual([
			"Empty target: no tables and no applied history, so nothing can be lost; 1 file applies without the unsafe gate",
			"Apply: 1_init.sql",
			"\nDone: 1 applied, 0 skipped",
		])
		expect(await tables(url)).toEqual(["__drizzle_migrations", "post"])
		const again = io(dir)
		expect(await runCli(["migrate", "apply", "core"], again)).toBe(0)
		expect(again.outputs).toEqual(["Skip (already applied): 1_init.sql", "\nDone: 0 applied, 1 skipped"])
	})

	it("takes one file with --file and another directory with --dir", async () => {
		const { dir, url } = configured({})
		mkdirSync(join(dir, "other"))
		writeFileSync(join(dir, "other", "1_a.sql"), "CREATE TABLE a (x);")
		writeSum(join(dir, "other"))
		writeFileSync(join(dir, "lone.sql"), "CREATE TABLE lone (x);")
		expect(await runCli(["migrate", "apply", "core", "--file", "lone.sql"], io(dir))).toBe(0)
		expect(await runCli(["migrate", "apply", "core", "--dir", "other"], io(dir))).toBe(0)
		expect(await tables(url)).toEqual(["__drizzle_migrations", "a", "lone"])
	})

	it("refuses a database the config does not declare, and --local", async () => {
		const { dir } = configured({})
		const unknown = io(dir)
		expect(await runCli(["migrate", "apply", "blog"], unknown)).toBe(1)
		expect(unknown.errors).toEqual(['comb.migrate.config.ts declares no database "blog". Available: core'])
		const local = io(dir)
		expect(await runCli(["migrate", "apply", "core", "--local"], local)).toBe(1)
		expect(local.errors).toEqual(["--local is for a D1 database; set local: true on its d1 provider"])
		const hashes = io(dir)
		expect(await runCli(["migrate", "baseline", "core", "--hashes"], hashes)).toBe(1)
		expect(hashes.errors).toEqual([
			"--hashes is for a D1 database, whose history records names alone: this one records each file's hash as it applies it",
		])
	})
})

describe("migrate on SQLite: a --file moved into the directory (M45)", () => {
	/* M45: moving a hotfix into the history is the usual next step, and it would run the hotfix again */
	it("refuses a pending file whose text a --file row holds, naming both, and lets baseline record it", async () => {
		const { dir } = configured({ "1_init.sql": "CREATE TABLE post (id TEXT);" })
		const hotfix = "CREATE TABLE audit (note TEXT);"
		writeFileSync(join(dir, "hotfix.sql"), hotfix)
		expect(await runCli(["migrate", "apply", "core", "--file", "hotfix.sql"], io(dir))).toBe(0)
		writeFileSync(join(dir, "m", "2_hotfix.sql"), hotfix)
		writeSum(join(dir, "m"))
		const refusal =
			"2_hotfix.sql has the text of ../hotfix.sql, applied with --file; run comb migrate baseline to record it, or remove it"
		for (const mode of ["check", "apply"]) {
			const run = io(dir)
			expect(await runCli(["migrate", mode, "core"], run), mode).toBe(1)
			expect(run.errors, mode).toEqual([refusal])
		}
		const status = io(dir)
		expect(await runCli(["migrate", "status", "core"], status)).toBe(0)
		expect(status.outputs).toContain(refusal)
		const baseline = io(dir)
		expect(await runCli(["migrate", "baseline", "core"], baseline)).toBe(0)
		expect(baseline.outputs).toContain("Marked applied: 2_hotfix.sql")
		expect(await runCli(["migrate", "check", "core"], io(dir))).toBe(0)
	})
})

/** A SQLite table rebuild of post, as Atlas writes it, copying `copied` */
const rebuild = (copied: string) =>
	`CREATE TABLE new_post (id TEXT, title TEXT);\nINSERT INTO new_post (${copied}) SELECT ${copied} FROM post;\nDROP TABLE post;\nALTER TABLE new_post RENAME TO post;`

const UNSAFE_REFUSAL = (file: string, what: string) =>
	`${file} is unsafe (${what}); confirm it on a terminal, or approve it in the file with a line "-- comb:allow-unsafe: <reason>"`

describe("migrate apply: approving an unsafe migration", () => {
	const DROP = { "1_init.sql": "CREATE TABLE post (id TEXT);", "2_drop.sql": "DROP TABLE post;" }

	it("refuses it with --yes and with nobody to ask, and asks on a terminal", async () => {
		const { dir, url } = configured(DROP)
		await keepOnly(url)
		const refused = io(dir)
		expect(await runCli(["migrate", "apply", "core", "--yes"], refused)).toBe(1)
		expect(refused.errors).toEqual([
			UNSAFE_REFUSAL("2_drop.sql", "DROP TABLE post; proof run: loses every row of post"),
		])
		const asked: string[] = []
		const no = io(dir, async (q) => (asked.push(q), false))
		expect(await runCli(["migrate", "apply", "core", "--yes"], no)).toBe(1)
		expect(asked[0]).toContain("This affects: core (core-dev)")
		/* every pending file is approved before any applies, so the refusal left 1_init.sql unapplied, and comb's history unmade (S7) */
		expect(await tables(url)).toEqual(["keep"])
		expect(
			await runCli(
				["migrate", "apply", "core"],
				io(dir, async () => true),
			),
		).toBe(0)
		expect(await tables(url)).toEqual(["__drizzle_migrations", "keep"])
	})

	it("runs it without asking when the file approves it with a reason, and says so", async () => {
		const { dir, url } = configured({
			...DROP,
			"2_drop.sql": "-- comb:allow-unsafe: post moved to the archive db\nDROP TABLE post;",
		})
		await keepOnly(url)
		const run = io(dir)
		expect(await runCli(["migrate", "apply", "core"], run)).toBe(0)
		expect(run.outputs).toContain("Approved in 2_drop.sql: post moved to the archive db")
		expect(await tables(url)).toEqual(["__drizzle_migrations", "keep"])
	})

	it("takes no approval without a reason", async () => {
		const { dir, url } = configured({ ...DROP, "2_drop.sql": "-- comb:allow-unsafe:\nDROP TABLE post;" })
		await keepOnly(url)
		const run = io(dir)
		expect(await runCli(["migrate", "apply", "core"], run)).toBe(1)
		expect(run.errors).toEqual([UNSAFE_REFUSAL("2_drop.sql", "DROP TABLE post; proof run: loses every row of post")])
	})

	it("reads a table rebuild against the earlier files: a column it leaves out is unsafe", async () => {
		const init = "CREATE TABLE post (id TEXT, title TEXT, body TEXT);"
		const lossy = configured({ "1_init.sql": init, "2_rebuild.sql": rebuild("id, title") })
		await keepOnly(lossy.url)
		const run = io(lossy.dir)
		expect(await runCli(["migrate", "apply", "core", "--yes"], run)).toBe(1)
		expect(run.errors[0]).toContain("2_rebuild.sql is unsafe (DROP COLUMN post.body;")
		const kept = configured({
			"1_init.sql": "CREATE TABLE post (id TEXT, title TEXT);",
			"2_rebuild.sql": rebuild("id, title"),
		})
		expect(await runCli(["migrate", "apply", "core", "--yes"], io(kept.dir))).toBe(0)
	})
})

describe("migrate apply: approving a cautious migration", () => {
	const INDEX = {
		"1_init.sql": "CREATE TABLE post (id TEXT);\nCREATE INDEX idx_post ON post (id);",
		"2_drop.sql": "DROP INDEX idx_post;",
	}

	it("refuses it with nobody to ask, and runs it with --yes or a yes on a terminal", async () => {
		const { dir, url } = configured(INDEX)
		await keepOnly(url)
		const refused = io(dir)
		expect(await runCli(["migrate", "apply", "core"], refused)).toBe(1)
		expect(refused.errors).toEqual([
			"2_drop.sql is cautious (DROP INDEX idx_post); pass --yes or confirm it on a terminal",
		])
		expect(await runCli(["migrate", "apply", "core", "--yes"], io(dir))).toBe(0)
		const again = configured(INDEX)
		await keepOnly(again.url)
		expect(
			await runCli(
				["migrate", "apply", "core"],
				io(again.dir, async () => true),
			),
		).toBe(0)
	})
})

describe("migrate check", () => {
	it("checks and approves what is pending, applying nothing, and refuses what apply would refuse", async () => {
		const { dir, url } = configured({ "1_init.sql": "CREATE TABLE post (id TEXT);" })
		await keepOnly(url)
		const check = io(dir)
		expect(await runCli(["migrate", "check", "core"], check)).toBe(0)
		expect(check.outputs).toEqual(["\nCheck passed: 1 pending: 1_init.sql"])
		/* check reads the history, and creates no table to read it from (M10) */
		expect(await tables(url)).toEqual(["keep"])
		writeFileSync(join(dir, "m", "2_drop.sql"), "DROP TABLE post;")
		writeSum(join(dir, "m"))
		const refused = io(dir)
		expect(await runCli(["migrate", "check", "core", "--yes"], refused)).toBe(1)
		expect(refused.errors[0]).toMatch(/^2_drop\.sql is unsafe/)
	})

	it("refuses a database file that does not exist, and creates none (M10)", async () => {
		const { dir } = configured({ "1_init.sql": "CREATE TABLE post (id TEXT);" })
		const check = io(dir)
		expect(await runCli(["migrate", "check", "core"], check)).toBe(1)
		expect(check.errors[0]).toMatch(
			/core\.db does not exist; check and status open a database read-only, and create none$/,
		)
		expect(existsSync(join(dir, "core.db"))).toBe(false)
	})

	it("refuses a directory whose atlas.sum does not match, and a pending file that sorts before an applied one", async () => {
		const { dir } = configured({ "2_b.sql": "CREATE TABLE b (x);" })
		expect(await runCli(["migrate", "apply", "core"], io(dir))).toBe(0)
		writeFileSync(join(dir, "m", "1_a.sql"), "CREATE TABLE a (x);")
		const stale = io(dir)
		expect(await runCli(["migrate", "check", "core"], stale)).toBe(1)
		expect(stale.errors[0]).toContain("atlas.sum does not match its migrations")
		writeSum(join(dir, "m"))
		const late = io(dir)
		expect(await runCli(["migrate", "apply", "core"], late)).toBe(1)
		expect(late.errors).toEqual([
			"1_a.sql was never applied, yet it sorts before 2_b.sql, which was; rename it to sort after the applied files",
		])
	})
})

describe("migrate baseline", () => {
	it("records each migration once the database's schema is the one they leave, and skips what is recorded", async () => {
		const { dir, url } = configured({ "1_init.sql": "CREATE TABLE post (id TEXT);" })
		const client = createClient({ url })
		await client.execute("CREATE TABLE post (id TEXT)")
		client.close()
		const first = io(dir)
		expect(await runCli(["migrate", "baseline", "core"], first)).toBe(0)
		expect(first.outputs).toEqual(["Marked applied: 1_init.sql", "\nBaseline done: 1 marked, 0 already tracked"])
		const again = io(dir)
		expect(await runCli(["migrate", "baseline", "core"], again)).toBe(0)
		expect(again.outputs).toEqual(["\nBaseline done: 0 marked, 1 already tracked"])
	})

	it("records nothing when the database's schema differs from the one the migrations leave", async () => {
		const { dir, url } = configured({ "1_init.sql": "CREATE TABLE post (id TEXT);" })
		const diff = { code: 0, stderr: "", stdout: "CREATE TABLE `post` (`id` text NULL);\n" }
		const drift = makeIo(dir, fakeAtlas({ schemaDiff: diff }))
		expect(await runCli(["migrate", "baseline", "core"], drift)).toBe(1)
		expect(drift.errors).toEqual([
			"core (core-dev)'s schema is not the one its migrations leave, so baseline records nothing; the difference:\nCREATE TABLE `post` (`id` text NULL);",
		])
		/* a refused baseline writes nothing, comb's history included (S7 of the 0.14.1 review) */
		expect(await tables(url)).toEqual([])
	})
})

describe("migrate status: comb's own history (M17)", () => {
	it("lists the files the database records and the ones pending, reading only, and has its own usage", async () => {
		const { dir, url } = configured({ "1_a.sql": "CREATE TABLE a (x);", "2_b.sql": "CREATE TABLE b (x);" })
		await keepOnly(url)
		const before = io(dir)
		expect(await runCli(["migrate", "status", "core"], before)).toBe(0)
		expect(before.outputs).toEqual(["Applied: none", "Pending: 1_a.sql, 2_b.sql"])
		expect(await tables(url)).toEqual(["keep"])
		expect(await runCli(["migrate", "apply", "core", "--file", "m/1_a.sql"], io(dir))).toBe(0)
		const after = io(dir)
		expect(await runCli(["migrate", "status", "core", "--json"], after)).toBe(0)
		expect(after.outputs.map((line) => JSON.parse(line) as unknown)).toEqual([
			{ applied: ["1_a.sql"], database: "core", pending: ["2_b.sql"], refused: [] },
		])
		expect(await runCli(["migrate", "apply", "core"], io(dir))).toBe(0)
		const done = io(dir)
		expect(await runCli(["migrate", "status", "core"], done)).toBe(0)
		expect(done.outputs).toEqual(["Applied: 1_a.sql, 2_b.sql", "Pending: none"])
		const usage = io(dir)
		expect(await runCli(["migrate", "status"], usage)).toBe(1)
		expect(usage.errors).toEqual([
			"Usage: comb migrate status <database> [-e <name>] [--dir <path>] [--local] [--json]",
		])
	})
})
