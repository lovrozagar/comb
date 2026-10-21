import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type FakeD1, fakeD1, writeSum } from "./__fixtures__/d1.ts"
import { makeIo, projects } from "./__fixtures__/io.ts"
import { runCli } from "./run.ts"

const temp = projects()
afterEach(temp.clean)

const TOML = `name = "probe"
compatibility_date = "2026-10-01"

[[d1_databases]]
binding = "CORE"
database_name = "core"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "atlas-migrations"
`

/** A worker project: its wrangler.toml, and these migrations in ./atlas-migrations with their sum */
function worker(migrations: Record<string, string>, toml = TOML): string {
	const dir = temp.make()
	writeFileSync(join(dir, "wrangler.toml"), toml)
	mkdirSync(join(dir, "atlas-migrations"))
	for (const [name, sql] of Object.entries(migrations)) writeFileSync(join(dir, "atlas-migrations", name), sql)
	writeSum(join(dir, "atlas-migrations"))
	return dir
}

const recorded = (d1: FakeD1, table = "d1_migrations") =>
	d1.db
		.prepare(`SELECT name FROM "${table}" ORDER BY id`)
		.all()
		.map((row) => row["name"])

const INIT = { "20260101000000_init.sql": "CREATE TABLE post (id TEXT);" }

describe("migrate apply on D1 without a migrate config", () => {
	it("checks, then applies through wrangler into d1_migrations, and finds nothing pending the next time", async () => {
		const dir = worker(INIT)
		const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
		const io = makeIo(dir, d1)
		expect(await runCli(["migrate", "apply", "core", "--local"], io)).toBe(0)
		expect(io.outputs).toEqual([
			"Empty target: no tables and no applied history, so nothing can be lost; 1 file apply without the unsafe gate",
			"Apply: 20260101000000_init.sql",
			"\nDone: 1 applied",
		])
		expect(recorded(d1)).toEqual(["20260101000000_init.sql"])
		const apply = d1.calls.find((call) => call[2] === "migrations") as string[]
		expect(apply).toEqual([
			"wrangler",
			"d1",
			"migrations",
			"apply",
			"core",
			"--local",
			"--config",
			join(dir, "wrangler.toml"),
		])
		expect(d1.db.prepare("SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'").all()).toEqual([])
		const again = makeIo(dir, d1)
		expect(await runCli(["migrate", "apply", "core", "--local"], again)).toBe(0)
		expect(again.outputs).toEqual(["No migrations to apply"])
	})

	it("runs every wrangler command remotely unless --local", async () => {
		const dir = worker(INIT)
		const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
		expect(await runCli(["migrate", "apply", "core"], makeIo(dir, d1))).toBe(0)
		expect(d1.calls.filter(([cmd]) => cmd === "wrangler").every((call) => call.includes("--remote"))).toBe(true)
	})

	it("refuses an unsafe pending file before wrangler runs, and checks without applying", async () => {
		const dir = worker({ ...INIT, "20260102000000_drop.sql": "DROP TABLE post;" })
		const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
		d1.db.exec("CREATE TABLE keep (x)")
		const io = makeIo(dir, d1)
		expect(await runCli(["migrate", "apply", "core", "--local"], io)).toBe(1)
		expect(io.errors[0]).toMatch(/^20260102000000_drop\.sql is unsafe/)
		expect(d1.calls.some((call) => call[2] === "migrations")).toBe(false)
		const safe = worker(INIT)
		const checked = fakeD1({ dir: join(safe, "atlas-migrations") })
		checked.db.exec("CREATE TABLE keep (x)")
		const check = makeIo(safe, checked)
		expect(await runCli(["migrate", "check", "core", "--local"], check)).toBe(0)
		expect(check.outputs).toEqual(["\nCheck passed: 1 pending: 20260101000000_init.sql"])
		/* a check never writes: no migrations table appears */
		expect(checked.db.prepare("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'").all()).toEqual([])
	})
})

describe("migrate apply on D1 without a migrate config: a failed apply", () => {
	it("fails when a file fails, which leaves no row for it, and when wrangler applies nothing", async () => {
		const dir = worker({ "20260101000000_bad.sql": "CREATE TABLE post (id TEXT);\nINSERT INTO missing VALUES (1);" })
		const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
		const io = makeIo(dir, d1)
		expect(await runCli(["migrate", "apply", "core", "--local"], io)).toBe(1)
		expect(io.errors[0]).toMatch(/^wrangler d1 migrations apply failed: Migration 20260101000000_bad\.sql failed/)
		expect(recorded(d1)).toEqual([])
		const declined = worker(INIT)
		const no = makeIo(declined, fakeD1({ declines: true, dir: join(declined, "atlas-migrations") }))
		expect(await runCli(["migrate", "apply", "core", "--local"], no)).toBe(1)
		expect(no.errors).toEqual([
			"wrangler recorded nothing in d1_migrations, where comb checked 20260101000000_init.sql; see the wrangler output above",
		])
	})
})

describe("migrate apply on D1 without a migrate config: order and refusals", () => {
	it("checks and applies in wrangler's order, by leading number, when prefixes differ in width", async () => {
		const dir = worker({
			"20250101000000_rebuild.sql":
				"CREATE TABLE new_t (id TEXT, a TEXT);\nINSERT INTO new_t (id, a) SELECT id, a FROM t;\nDROP TABLE t;\nALTER TABLE new_t RENAME TO t;",
			"20261020_init.sql": "CREATE TABLE t (id TEXT, a TEXT);",
		})
		const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
		expect(await runCli(["migrate", "apply", "core", "--local", "--yes"], makeIo(dir, d1))).toBe(0)
		expect(recorded(d1)).toEqual(["20261020_init.sql", "20250101000000_rebuild.sql"])
	})

	it("refuses --file, -e, a missing wrangler config, a binding it lacks, and another migrations directory", async () => {
		const dir = worker(INIT)
		const cases: Array<[string[], string, string]> = [
			[["--file", "x.sql"], dir, "--file does not apply to a D1 database: wrangler applies its migrations directory"],
			[["-e", "prod"], dir, "-e/--env needs comb.migrate.config.ts to define environments"],
			[["--local"], temp.make(), "no wrangler config in "],
		]
		for (const [flags, cwd, message] of cases) {
			const io = makeIo(cwd, fakeD1({ dir }))
			expect(await runCli(["migrate", "apply", "core", ...flags], io)).toBe(1)
			expect(io.errors[0]).toContain(message)
		}
		const bare = makeIo(dir)
		expect(await runCli(["migrate", "apply", "blog", "--local", "--dir", "nowhere"], bare)).toBe(1)
		expect(bare.errors).toEqual([`Migrations dir not found: ${join(dir, "nowhere")}`])
		/* without a runner given, comb runs the real wrangler, which the refusal comes before */
		const real = makeIo(dir)
		expect(await runCli(["migrate", "apply", "blog", "--local"], real)).toBe(1)
		expect(real.errors).toEqual([`${join(dir, "wrangler.toml")} has no D1 database named or bound as blog`])
		const unbound = makeIo(dir, fakeD1({ dir }))
		expect(await runCli(["migrate", "apply", "blog", "--local"], unbound)).toBe(1)
		expect(unbound.errors).toEqual([`${join(dir, "wrangler.toml")} has no D1 database named or bound as blog`])
		const elsewhere = worker(INIT, TOML.replace('migrations_dir = "atlas-migrations"', 'migrations_dir = "migrations"'))
		const io = makeIo(elsewhere, fakeD1({ dir }))
		expect(await runCli(["migrate", "apply", "core", "--local"], io)).toBe(1)
		expect(io.errors[0]).toContain(
			`applies core's migrations from ${join(elsewhere, "migrations")}, but comb reads them`,
		)
		const pattern = worker(
			INIT,
			TOML.replace("migrations_dir", 'migrations_pattern = "atlas-migrations/**/*.sql"\nmigrations_dir'),
		)
		const patterned = makeIo(pattern, fakeD1({ dir }))
		expect(await runCli(["migrate", "apply", "core", "--local"], patterned)).toBe(1)
		expect(patterned.errors[0]).toContain("sets migrations_pattern atlas-migrations/**/*.sql")
	})
})

/** A database comb 0.7 migrated: the init file recorded by hash in __drizzle_migrations */
async function migratedBy07(dir: string, d1: FakeD1): Promise<void> {
	d1.db.exec(
		"CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_at INTEGER)",
	)
	const { migrationHashes } = await import("../migrate/core/parse.ts")
	const hash = migrationHashes(INIT["20260101000000_init.sql"])[0] as string
	d1.db.exec(`CREATE TABLE post (id TEXT); INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${hash}', 1)`)
	writeFileSync(join(dir, "atlas-migrations", "20260102000000_more.sql"), "CREATE TABLE tag (id TEXT);")
	writeSum(join(dir, "atlas-migrations"))
}

describe("migrate on D1: wrangler itself", () => {
	it("names the package to install when wrangler is missing, and passes any other failure on", async () => {
		const { wranglerReader } = await import("./migrate-d1.ts")
		await expect(wranglerReader("comb-no-such-package")).rejects.toThrow(
			"comb needs wrangler (>=4.147.0 <5) to migrate a D1 database; run comb through a package script, or install wrangler",
		)
		await expect(wranglerReader("data:text/javascript,throw new Error('boom')")).rejects.toThrow("boom")
	})

	it("lists nothing applied before the first apply, and nothing pending after it", async () => {
		const dir = worker(INIT)
		const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
		const before = makeIo(dir, d1)
		expect(await runCli(["migrate", "status", "core", "--local"], before)).toBe(0)
		expect(before.outputs).toEqual(["Applied: none", "Pending: 20260101000000_init.sql"])
		expect(await runCli(["migrate", "apply", "core", "--local"], makeIo(dir, d1))).toBe(0)
		const after = makeIo(dir, d1)
		expect(await runCli(["migrate", "status", "core", "--local"], after)).toBe(0)
		expect(after.outputs).toEqual(["Applied: 20260101000000_init.sql", "Pending: none"])
		const baseline = makeIo(dir, d1)
		d1.db.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER)")
		expect(await runCli(["migrate", "baseline", "core", "--local"], baseline)).toBe(0)
		expect(baseline.outputs).toEqual(["\nBaseline done: 0 marked"])
		const check = makeIo(dir, d1)
		expect(await runCli(["migrate", "check", "core", "--local"], check)).toBe(0)
		expect(check.outputs).toEqual(["\nCheck passed: 0 pending"])
	})
})

describe("migrate apply on D1: comb's history before 0.8", () => {
	it("refuses to apply until baseline copies the record, then applies only the rest", async () => {
		const dir = worker(INIT)
		const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
		await migratedBy07(dir, d1)
		const refused = makeIo(dir, d1)
		expect(await runCli(["migrate", "apply", "core", "--local"], refused)).toBe(1)
		expect(refused.errors).toEqual([
			"core records 20260101000000_init.sql in __drizzle_migrations, comb's history before 0.8, but not in d1_migrations, wrangler's; run comb migrate baseline once to copy the record",
		])
		const baseline = makeIo(dir, d1)
		expect(await runCli(["migrate", "baseline", "core", "--local"], baseline)).toBe(0)
		expect(baseline.outputs).toEqual([
			"Marked applied: 20260101000000_init.sql",
			"Not marked: 20260102000000_more.sql (__drizzle_migrations has no record of it; comb migrate apply runs it)",
			"\nBaseline done: 1 marked",
		])
		const status = makeIo(dir, d1)
		expect(await runCli(["migrate", "status", "core", "--local"], status)).toBe(0)
		expect(status.outputs).toEqual(["Applied: 20260101000000_init.sql", "Pending: 20260102000000_more.sql"])
		expect(await runCli(["migrate", "apply", "core", "--local"], makeIo(dir, d1))).toBe(0)
		expect(recorded(d1)).toEqual(["20260101000000_init.sql", "20260102000000_more.sql"])
	})

	it("refuses a baseline with no history to copy from", async () => {
		const dir = worker(INIT)
		const io = makeIo(dir, fakeD1({ dir: join(dir, "atlas-migrations") }))
		expect(await runCli(["migrate", "baseline", "core", "--local"], io)).toBe(1)
		expect(io.errors).toEqual([
			"core has no __drizzle_migrations to copy from; baseline records only what a history shows was applied",
		])
	})
})

const ENV_ONLY = `name = "probe"
compatibility_date = "2026-10-01"

[env.prod]
[[env.prod.d1_databases]]
binding = "CORE_DB"
database_name = "core-prod"
database_id = "11111111-1111-1111-1111-111111111111"
migrations_dir = "../db/atlas-migrations"
migrations_table = "schema_history"

[env.staging]
vars = { STAGE = "staging" }
`

/** db/ holds comb.migrate.config.ts and the migrations; worker/ holds the wrangler config that binds them */
function split(): { db: string; root: string } {
	const root = temp.make()
	mkdirSync(join(root, "worker"))
	writeFileSync(join(root, "worker", "wrangler.toml"), ENV_ONLY)
	mkdirSync(join(root, "db", "atlas-migrations"), { recursive: true })
	writeFileSync(join(root, "db", "atlas-migrations", "20260101000000_init.sql"), INIT["20260101000000_init.sql"])
	writeSum(join(root, "db", "atlas-migrations"))
	writeFileSync(
		join(root, "db", "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./atlas-migrations", environments: {
prod: { name: "core-prod", provider: { type: "d1", databaseName: "core-prod", wranglerConfig: "../worker/wrangler.toml", wranglerEnv: "prod" } },
staging: { name: "core-staging", provider: { type: "d1", databaseName: "core-staging", wranglerConfig: "../worker/wrangler.toml", wranglerEnv: "staging" } },
} } } }\n`,
	)
	return { db: join(root, "db"), root }
}

describe("migrate apply on D1 through comb.migrate.config.ts", () => {
	it("reads an env-only binding with a custom migrations table, and passes its config and env to wrangler", async () => {
		const { db, root } = split()
		const d1 = fakeD1({ dir: join(db, "atlas-migrations"), table: "schema_history" })
		const io = makeIo(db, d1)
		expect(await runCli(["migrate", "apply", "core", "-e", "prod"], io)).toBe(0)
		expect(recorded(d1, "schema_history")).toEqual(["20260101000000_init.sql"])
		const config = join(root, "worker", "wrangler.toml")
		const apply = d1.calls.find((call) => call[2] === "migrations")
		expect(apply).toEqual([
			"wrangler",
			"d1",
			"migrations",
			"apply",
			"core-prod",
			"--remote",
			"--config",
			config,
			"--env",
			"prod",
		])
	})

	it("refuses an environment whose wrangler env lacks the binding, and --local", async () => {
		const { db, root } = split()
		const io = makeIo(db, fakeD1({ dir: join(db, "atlas-migrations") }))
		expect(await runCli(["migrate", "apply", "core", "-e", "staging"], io)).toBe(1)
		expect(io.errors).toEqual([
			`${join(root, "worker", "wrangler.toml")} (env staging) has no D1 database named or bound as core-staging`,
		])
		const local = makeIo(db, fakeD1({ dir: join(db, "atlas-migrations") }))
		expect(await runCli(["migrate", "apply", "core", "-e", "prod", "--local"], local)).toBe(1)
		expect(local.errors).toEqual(["--local applies without comb.migrate.config.ts; set local: true on its d1 provider"])
	})
})

describe("migrate apply on D1 through comb.migrate.config.ts: the database's name", () => {
	it("names the database to wrangler by its provider's databaseName, not the environment's name", async () => {
		const { db, root } = split()
		writeFileSync(
			join(db, "comb.migrate.config.ts"),
			`export default { databases: { core: { migrationsDir: "./atlas-migrations", environments: {
prod: { name: "prod", provider: { type: "d1", databaseName: "CORE_DB", wranglerConfig: "../worker/wrangler.toml", wranglerEnv: "prod" } },
} } } }\n`,
		)
		const d1 = fakeD1({ dir: join(db, "atlas-migrations"), table: "schema_history" })
		const io = makeIo(db, d1)
		expect(await runCli(["migrate", "apply", "core", "-e", "prod"], io), io.errors.join("\n")).toBe(0)
		const apply = d1.calls.find((call) => call[2] === "migrations")
		expect(apply?.slice(0, 5)).toEqual(["wrangler", "d1", "migrations", "apply", "CORE_DB"])
		expect(join(root, "worker", "wrangler.toml")).toBe(apply?.[7])
	})
})

describe("migrate apply on D1 through comb.migrate.config.ts: its wrangler config", () => {
	it("takes the wrangler config beside comb.migrate.config.ts when none is set, and refuses when there is none", async () => {
		const dir = worker(INIT)
		writeFileSync(
			join(dir, "comb.migrate.config.ts"),
			'export default { databases: { core: { migrationsDir: "./atlas-migrations", name: "core", provider: { type: "d1", databaseName: "core", local: true } } } }\n',
		)
		const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
		expect(await runCli(["migrate", "apply", "core"], makeIo(dir, d1))).toBe(0)
		expect(recorded(d1)).toEqual(["20260101000000_init.sql"])
		const bare = temp.make()
		writeFileSync(
			join(bare, "comb.migrate.config.ts"),
			`export default { databases: { core: { migrationsDir: "./m", name: "core", provider: { type: "d1", databaseName: "core" } } } }\n`,
		)
		const io = makeIo(bare, fakeD1({ dir: bare }))
		expect(await runCli(["migrate", "apply", "core"], io)).toBe(1)
		expect(io.errors).toEqual([
			"no wrangler config next to comb.migrate.config.ts; set wranglerConfig on core's d1 provider",
		])
	})
})

/** The one JSON object a --json run printed as its stdout */
function json(io: { outputs: string[] }): Record<string, unknown> {
	expect(io.outputs).toHaveLength(1)
	return JSON.parse(io.outputs[0] as string) as Record<string, unknown>
}

describe("migrate apply, check and status --json on D1 (C5)", () => {
	it("prints one JSON object as the only stdout, the human lines on stderr", async () => {
		const dir = worker(INIT)
		const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
		const status = makeIo(dir, d1)
		expect(await runCli(["migrate", "status", "core", "--local", "--json"], status)).toBe(0)
		expect(json(status)).toEqual({ applied: [], database: "core", pending: ["20260101000000_init.sql"], refused: [] })
		const check = makeIo(dir, d1)
		expect(await runCli(["migrate", "check", "core", "--local", "--json"], check)).toBe(0)
		expect(json(check)).toEqual({ applied: [], database: "core", pending: ["20260101000000_init.sql"], refused: [] })
		const apply = makeIo(dir, d1)
		expect(await runCli(["migrate", "apply", "core", "--local", "--json"], apply)).toBe(0)
		expect(json(apply)).toEqual({ applied: ["20260101000000_init.sql"], database: "core", pending: [], refused: [] })
		expect(apply.errors).toContain("Apply: 20260101000000_init.sql")
	})

	it("reports a refused file in the object, and exits 1", async () => {
		const dir = worker({ ...INIT, "20260102000000_drop.sql": "DROP TABLE post;" })
		const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
		d1.db.exec("CREATE TABLE keep (x)")
		const io = makeIo(dir, d1)
		expect(await runCli(["migrate", "apply", "core", "--local", "--json"], io)).toBe(1)
		const out = json(io)
		/* a refusal names every file that was pending (M16) */
		expect(out).toMatchObject({
			applied: [],
			database: "core",
			pending: ["20260101000000_init.sql", "20260102000000_drop.sql"],
		})
		expect((out["refused"] as string[])[0]).toMatch(/^20260102000000_drop\.sql is unsafe/)
	})
})
