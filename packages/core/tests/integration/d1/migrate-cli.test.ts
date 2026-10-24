/**
 * `comb migrate` on D1 through the real wrangler --local (a local D1) and the real Atlas: comb
 * checks the pending files, `wrangler d1 migrations apply` runs each with its `d1_migrations` row
 * in one batch, and comb reads that table back. A database comb 0.7 migrated keeps its record in
 * `__drizzle_migrations` until `baseline` copies it.
 */
import { createClient } from "@libsql/client"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../../src/cli/index.ts"
import { localD1Path } from "../../../src/migrate/core/d1-binding.ts"
import { migrationHashes } from "../../../src/migrate/core/parse.ts"
import { guardRebuilds } from "../../../src/migrate/core/rebuild-guard.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { run, type Run } from "../../../src/migrate/core/process.ts"

const WRANGLER = path.join(
	path.dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
	"bin/wrangler.js",
)

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

/** A worker project whose wrangler.toml applies ./atlas-migrations, holding `migrations` and their atlas.sum */
function project(migrations: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-d1-cli-"))
	dirs.push(dir)
	fs.writeFileSync(
		path.join(dir, "wrangler.toml"),
		'name = "probe"\ncompatibility_date = "2026-10-01"\n\n[[d1_databases]]\nbinding = "CORE"\ndatabase_name = "core"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\nmigrations_dir = "atlas-migrations"\n',
	)
	fs.mkdirSync(path.join(dir, "atlas-migrations"))
	write(dir, migrations)
	return dir
}

/** Migration files added to the project, with atlas.sum rehashed */
function write(dir: string, migrations: Record<string, string>): void {
	for (const [name, sql] of Object.entries(migrations)) fs.writeFileSync(path.join(dir, "atlas-migrations", name), sql)
	spawnSync("atlas", ["migrate", "hash", "--dir", `file://${path.join(dir, "atlas-migrations")}`])
}

/** wrangler from node_modules, run in the project */
const wrangler =
	(dir: string): Run =>
	(cmd, args, options) =>
		cmd === "wrangler" ? run(process.execPath, [WRANGLER, ...args], { ...options, cwd: dir }) : run(cmd, args, options)

function io(dir: string) {
	const out: string[] = []
	const err: string[] = []
	return {
		cwd: dir,
		err: (line: string) => err.push(line),
		errors: err,
		out: (line: string) => out.push(line),
		outputs: out,
		run: wrangler(dir),
	}
}

/** One column of `sql` on the project's local D1 */
function column(dir: string, sql: string): unknown[] {
	const ran = wrangler(dir)("wrangler", ["d1", "execute", "core", "--local", "--json", `--command=${sql}`])
	const [first] = JSON.parse(ran.stdout) as Array<{ results: Array<Record<string, unknown>> }>
	return (first?.results ?? []).map((row) => Object.values(row)[0])
}

const INIT = { "20260101000000_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY);" }

describe("comb migrate on D1 through wrangler, --local", () => {
	it("applies through wrangler into d1_migrations, lists it as applied, and finds nothing pending after", async () => {
		const dir = project(INIT)
		const apply = io(dir)
		expect(await runCli(["migrate", "apply", "core", "--local"], apply), apply.errors.join("\n")).toBe(0)
		expect(apply.outputs).toContain("\nDone: 1 applied")
		expect(column(dir, "SELECT name FROM d1_migrations")).toEqual(["20260101000000_init.sql"])
		expect(column(dir, "SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'")).toEqual([])
		const status = io(dir)
		expect(await runCli(["migrate", "status", "core", "--local"], status)).toBe(0)
		expect(status.outputs).toEqual(["Applied: 20260101000000_init.sql", "Pending: none"])
		const again = io(dir)
		expect(await runCli(["migrate", "apply", "core", "--local"], again)).toBe(0)
		expect(again.outputs).toEqual(["No migrations to apply"])
	}, 120_000)

	it("applies none of a file that fails partway, records nothing, and applies it once fixed", async () => {
		const dir = project({ "20260101000000_bad.sql": "CREATE TABLE post (id TEXT);\nINSERT INTO missing VALUES (1);" })
		expect(await runCli(["migrate", "apply", "core", "--local"], io(dir))).toBe(1)
		expect(column(dir, "SELECT name FROM d1_migrations")).toEqual([])
		expect(column(dir, "SELECT name FROM sqlite_master WHERE name = 'post'")).toEqual([])
		write(dir, { "20260101000000_bad.sql": "CREATE TABLE post (id TEXT);" })
		const fixed = io(dir)
		expect(await runCli(["migrate", "apply", "core", "--local"], fixed), fixed.errors.join("\n")).toBe(0)
		expect(column(dir, "SELECT name FROM d1_migrations")).toEqual(["20260101000000_bad.sql"])
	}, 120_000)
})

describe("comb migrate on D1 through wrangler, --local: history and the live schema", () => {
	it("copies comb 0.7's record into d1_migrations with baseline, so apply runs only what was never applied", async () => {
		const dir = project(INIT)
		const hash = migrationHashes(INIT["20260101000000_init.sql"])[0] as string
		const setup = `CREATE TABLE post (id TEXT PRIMARY KEY); CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL); INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${hash}', 1)`
		expect(wrangler(dir)("wrangler", ["d1", "execute", "core", "--local", `--command=${setup}`]).code).toBe(0)
		write(dir, { "20260102000000_tag.sql": "CREATE TABLE tag (id TEXT);" })
		const refused = io(dir)
		expect(await runCli(["migrate", "apply", "core", "--local"], refused)).toBe(1)
		expect(refused.errors[0]).toContain("run comb migrate baseline once to copy the record")
		expect(await runCli(["migrate", "baseline", "core", "--local"], io(dir))).toBe(0)
		const apply = io(dir)
		expect(await runCli(["migrate", "apply", "core", "--local"], apply), apply.errors.join("\n")).toBe(0)
		expect(apply.outputs).toEqual(["Apply: 20260102000000_tag.sql", "\nDone: 1 applied"])
		expect(column(dir, "SELECT name FROM d1_migrations ORDER BY id")).toEqual([
			"20260101000000_init.sql",
			"20260102000000_tag.sql",
		])
	}, 120_000)

	it("refuses a guarded rebuild a table no migration made would cascade from, before wrangler runs, and keeps its rows", async () => {
		const init =
			"CREATE TABLE `u` (`id` integer PRIMARY KEY);\nCREATE TABLE `post` (`id` integer PRIMARY KEY, `u` integer REFERENCES `u`(`id`) ON DELETE CASCADE);"
		const dir = project({ "20260101000000_init.sql": init })
		expect(await runCli(["migrate", "apply", "core", "--local"], io(dir))).toBe(0)
		const outside =
			"CREATE TABLE extra (u integer REFERENCES u(id) ON DELETE CASCADE); INSERT INTO u VALUES (1); INSERT INTO extra VALUES (1)"
		expect(wrangler(dir)("wrangler", ["d1", "execute", "core", "--local", `--command=${outside}`]).code).toBe(0)
		const rebuild = guardRebuilds(
			"CREATE TABLE `new_u` (`id` integer NOT NULL, PRIMARY KEY (`id`));\nINSERT INTO `new_u` (`id`) SELECT `id` FROM `u`;\nDROP TABLE `u`;\nALTER TABLE `new_u` RENAME TO `u`;\n",
			extractSchema(init),
		)
		write(dir, { "20260102000000_rebuild.sql": rebuild })
		const refused = io(dir)
		expect(await runCli(["migrate", "apply", "core", "--local", "--yes"], refused)).toBe(1)
		/* the live guard runs first and names the cause; the proof would see the same cascade as lost rows (M17) */
		expect(refused.errors[0]).toMatch(
			/^20260102000000_rebuild\.sql rebuilds u, which the database's table extra references/,
		)
		expect(column(dir, "SELECT count(*) FROM extra")).toEqual([1])
		expect(column(dir, "SELECT name FROM d1_migrations")).toEqual(["20260101000000_init.sql"])
	}, 120_000)
})

/* M33 of the 0.13 review: check and status read a local D1 only where wrangler already keeps one */
describe("comb migrate check and status on D1 --local, the local database missing", () => {
	it("refuse, saying comb cannot confirm it exists, and create none", async () => {
		const dir = project(INIT)
		for (const mode of ["check", "status"]) {
			const out = io(dir)
			expect(await runCli(["migrate", mode, "core", "--local"], out)).toBe(1)
			expect(out.errors[0]).toMatch(/^comb cannot confirm core's local database exists/)
		}
		expect(fs.existsSync(path.join(dir, ".wrangler"))).toBe(false)
	}, 120_000)

	it.each([
		["database_id", { database_id: "11111111-1111-1111-1111-111111111111" }],
		[
			"preview_database_id",
			{
				database_id: "22222222-2222-2222-2222-222222222222",
				preview_database_id: "33333333-3333-3333-3333-333333333333",
			},
		],
		["the binding alone", {}],
	])(
		"names the file wrangler keeps a local database in, by %s",
		(_label, ids) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-d1-local-"))
			dirs.push(dir)
			const entry = { binding: "CORE", database_name: "core", ...ids }
			fs.writeFileSync(
				path.join(dir, "wrangler.json"),
				JSON.stringify({ compatibility_date: "2026-10-01", d1_databases: [entry], name: "probe" }),
			)
			expect(fs.existsSync(localD1Path(dir, entry))).toBe(false)
			expect(wrangler(dir)("wrangler", ["d1", "execute", "CORE", "--local", "--command=SELECT 1"]).code).toBe(0)
			expect(fs.existsSync(localD1Path(dir, entry))).toBe(true)
		},
		120_000,
	)
})

/* M40 on D1 --local: check and apply prove a pending file on comb's copy before wrangler runs, so
   a file that attaches another database to delete its rows is refused there, and those rows stay */
describe("comb migrate on D1 --local never runs a file that reaches outside its database (M40)", () => {
	it("refuses it in check and apply, and the attached database keeps its rows", async () => {
		const dir = project(INIT)
		expect(await runCli(["migrate", "apply", "core", "--local"], io(dir))).toBe(0)
		const live = path.join(dir, "live.db")
		const seed = createClient({ url: `file:${live}` })
		await seed.executeMultiple(
			"CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); INSERT INTO users VALUES (1, 'a@x.io'), (2, 'b@x.io');",
		)
		seed.close()
		write(dir, { "20260102000000_attach.sql": `ATTACH '${live}' AS live;\nDELETE FROM live.users;` })
		for (const command of ["check", "apply"]) {
			const ran = io(dir)
			expect(await runCli(["migrate", command, "core", "--local"], ran)).toBe(1)
			expect(ran.errors.join("\n")).toContain("comb never runs ATTACH in a migration")
		}
		const read = createClient({ url: `file:${live}` })
		expect((await read.execute("SELECT id FROM users ORDER BY id")).rows.map((row) => row[0])).toEqual([1, 2])
		read.close()
		expect(column(dir, "SELECT name FROM d1_migrations")).toEqual(["20260101000000_init.sql"])
	}, 120_000)
})
