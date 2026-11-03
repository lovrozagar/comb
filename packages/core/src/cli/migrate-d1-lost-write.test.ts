/**
 * S2 and S3 of r19: a name is in wrangler's table only once its hash is in comb's, so a rerun after any
 * lost wrangler call converges: baseline whichever call is lost, a half-done 0.17.0 baseline, and
 * apply's hash record and read-back
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Run } from "../migrate/core/process.ts"
import {
	asWrangler,
	type FakeD1,
	fakeD1,
	LIVE_NOT_JSON,
	localD1,
	READS_LIVE_JSON,
	writeSum,
} from "./__fixtures__/d1.ts"
import { makeIo, projects, runCliWithFakes } from "./__fixtures__/io.ts"

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
function worker(migrations: Record<string, string>): string {
	const dir = temp.make()
	writeFileSync(join(dir, "wrangler.toml"), TOML)
	mkdirSync(join(dir, "atlas-migrations"))
	for (const [name, sql] of Object.entries(migrations)) writeFileSync(join(dir, "atlas-migrations", name), sql)
	writeSum(join(dir, "atlas-migrations"))
	localD1(dir, { binding: "CORE", database_id: "00000000-0000-0000-0000-000000000000" })
	return dir
}

const recorded = (d1: FakeD1) =>
	d1.db
		.prepare(`SELECT name FROM "d1_migrations" ORDER BY id`)
		.all()
		.map((row) => row["name"])

const INIT = { "20260101000000_init.sql": "CREATE TABLE post (id TEXT);" }

/** A migration's name in history07, long enough that 600 of them take several --command calls */
const longName = (i: number) =>
	`20261028${String(i).padStart(6, "0")}_a_migration_with_a_long_descriptive_name_${i}.sql`

/**
 * `d1` with its `at`-th write lost, as a network error on --remote loses one: a `--command` that is no
 * --json read fails once, before wrangler runs it, and every other call goes through
 */
function losing(d1: FakeD1, at: number): FakeD1 {
	let writes = 0
	const run: Run = asWrangler((cmd, args, options) => {
		const write = cmd === "wrangler" && args.some((arg) => arg.startsWith("--command=")) && !args.includes("--json")
		if (write && ++writes === at) return { code: 1, stderr: "fetch failed: ECONNRESET", stdout: "" }
		return d1(cmd, args, options)
	})
	return Object.assign(run, { calls: d1.calls, db: d1.db })
}

/** The `--command` writes a run took, each a call a network error can lose on its own */
const writes = (d1: FakeD1) =>
	d1.calls.filter((call) => call.some((arg) => arg.startsWith("--command=")) && !call.includes("--json")).length

const count = (d1: FakeD1, table: string) =>
	(d1.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n

/** A database comb 0.7 migrated through `files` files, long names enough that baseline's copy takes several --command calls */
async function history07(files: number): Promise<{ d1: FakeD1; dir: string }> {
	const { generateMigrationHash } = await import("../migrate/core/parse.ts")
	const sql = Array.from({ length: files }, (_, i) => `CREATE TABLE t${i} (id TEXT);`)
	const dir = worker(Object.fromEntries(sql.map((text, i) => [longName(i), text])))
	const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
	d1.db.exec(
		"CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_at INTEGER)",
	)
	const record = d1.db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, 1)")
	for (const text of sql) {
		d1.db.exec(text)
		record.run(generateMigrationHash(text))
	}
	return { d1, dir }
}

describe("migrate baseline on D1 after a lost write: whichever call is lost, and a half-done 0.17.0 baseline", () => {
	it("baseline: the copy takes several calls, and a rerun after losing any one of them records every name and hash", async () => {
		const files = 600
		const probe = await history07(files)
		expect(await runCliWithFakes(["migrate", "baseline", "core", "--local"], makeIo(probe.dir, probe.d1))).toBe(0)
		const calls = writes(probe.d1)
		expect(calls).toBeGreaterThan(1)
		for (let at = 1; at <= calls; at++) {
			const { d1, dir } = await history07(files)
			expect(await runCliWithFakes(["migrate", "baseline", "core", "--local"], makeIo(dir, losing(d1, at)))).toBe(1)
			expect(await runCliWithFakes(["migrate", "baseline", "core", "--local"], makeIo(dir, d1))).toBe(0)
			expect([at, count(d1, "d1_migrations"), count(d1, "_comb_migration_hashes")]).toEqual([at, files, files])
			const status = makeIo(dir, d1)
			expect(await runCliWithFakes(["migrate", "status", "core", "--local"], status)).toBe(0)
			expect(status.outputs.join("\n")).not.toContain("No hash recorded")
		}
	})

	it("baseline: a database 0.17.0 left with wrangler's rows and no hashes gets the hashes __drizzle_migrations vouches for", async () => {
		const { d1, dir } = await history07(3)
		expect(await runCliWithFakes(["migrate", "baseline", "core", "--local"], makeIo(dir, d1))).toBe(0)
		d1.db.exec("DELETE FROM _comb_migration_hashes WHERE name LIKE '%_1.sql' OR name LIKE '%_2.sql'")
		const io = makeIo(dir, d1)
		expect(await runCliWithFakes(["migrate", "baseline", "core", "--local"], io)).toBe(0)
		expect(io.outputs).toEqual([
			"Hash recorded: 20261028000001_a_migration_with_a_long_descriptive_name_1.sql",
			"Hash recorded: 20261028000002_a_migration_with_a_long_descriptive_name_2.sql",
			"\nBaseline done: 0 marked, 2 hashes recorded",
		])
		expect(count(d1, "_comb_migration_hashes")).toBe(3)
		d1.db.exec("DELETE FROM _comb_migration_hashes WHERE name LIKE '%_0.sql'")
		const one = makeIo(dir, d1)
		expect(await runCliWithFakes(["migrate", "baseline", "core", "--local"], one)).toBe(0)
		expect(one.outputs.at(-1)).toBe("\nBaseline done: 0 marked, 1 hash recorded")
	})
})

describe("migrate apply on D1 after a lost hash record", () => {
	it("apply: a lost hash record applies nothing, the rerun records every hash, and an applied file edited since is refused", async () => {
		const dir = worker({ ...INIT, "20260102000000_more.sql": "CREATE TABLE tag (id TEXT);" })
		const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
		const lost = makeIo(dir, losing(d1, 1))
		expect(await runCliWithFakes(["migrate", "apply", "core", "--local", "--json"], lost)).toBe(1)
		const reported = JSON.parse(lost.outputs.at(-1) as string) as { applied: string[] }
		const status = makeIo(dir, d1)
		expect(await runCliWithFakes(["migrate", "status", "core", "--local", "--json"], status)).toBe(0)
		/* what --json says committed is what wrangler's table holds */
		expect(reported.applied).toEqual((JSON.parse(status.outputs.at(-1) as string) as { applied: string[] }).applied)
		expect(await runCliWithFakes(["migrate", "apply", "core", "--local"], makeIo(dir, d1))).toBe(0)
		expect(recorded(d1)).toEqual(["20260101000000_init.sql", "20260102000000_more.sql"])
		const after = makeIo(dir, d1)
		expect(await runCliWithFakes(["migrate", "status", "core", "--local"], after)).toBe(0)
		expect(after.outputs).toEqual(["Applied: 20260101000000_init.sql, 20260102000000_more.sql", "Pending: none"])
		writeFileSync(join(dir, "atlas-migrations", "20260101000000_init.sql"), "CREATE TABLE post (id TEXT, x TEXT);")
		writeSum(join(dir, "atlas-migrations"))
		const check = makeIo(dir, d1)
		expect(await runCliWithFakes(["migrate", "check", "core", "--local"], check)).toBe(1)
		expect(check.errors[0]).toMatch(/^20260101000000_init.sql was applied, then edited/)
	})
})

/* whether wrangler's own run ended well or not, the read-back that follows it can be lost */
describe("migrate apply on D1 after a lost read-back", () => {
	it.each(["ran", "failed"])(
		"is refused after wrangler %s, naming the files and telling status to say which committed",
		async (how) => {
			const bad = { "20260102000000_bad.sql": READS_LIVE_JSON }
			const dir = worker(how === "ran" ? INIT : { ...INIT, ...bad })
			const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
			d1.db.exec(LIVE_NOT_JSON)
			let ran = false
			const blind: Run = asWrangler((cmd, args, options) => {
				if (args[1] === "migrations") ran = true
				else if (ran && args.includes("--json")) return { code: 1, stderr: "fetch failed: ECONNRESET", stdout: "" }
				return d1(cmd, args, options)
			})
			const io = makeIo(dir, Object.assign(blind, { calls: d1.calls, db: d1.db }))
			expect(await runCliWithFakes(["migrate", "apply", "core", "--local", "--json"], io)).toBe(1)
			const report = JSON.parse(io.outputs.at(-1) as string) as {
				applied: string[]
				pending: string[]
				refused: string[]
				unknown: string[]
			}
			/* S3 of r20: which committed is unknown, so none is pending, as on SQLite */
			expect([report.applied, report.pending, report.unknown[0], report.refused]).toEqual([
				[],
				[],
				"20260101000000_init.sql",
				[
					expect.stringMatching(
						new RegExp(
							`^wrangler d1 migrations apply ${how}, then reading back what it recorded in d1_migrations failed: .*comb migrate status says which`,
						),
					),
				],
			])
		},
	)
})

/* SD4 of r22: a file that lands in the directory while wrangler runs, as a diff or a checkout writes one */
describe("migrate apply on D1 when wrangler applies a file comb never checked", () => {
	it("names each file wrangler applied that comb never checked, in the message and under applied in --json", async () => {
		const dir = worker(INIT)
		const d1 = fakeD1({ dir: join(dir, "atlas-migrations") })
		const late: Run = asWrangler((cmd, args, options) => {
			if (args[1] === "migrations")
				writeFileSync(join(dir, "atlas-migrations", "20260102000000_late.sql"), "CREATE TABLE late (id TEXT);")
			return d1(cmd, args, options)
		})
		const io = makeIo(dir, Object.assign(late, { calls: d1.calls, db: d1.db }))
		expect(await runCliWithFakes(["migrate", "apply", "core", "--local", "--json"], io)).toBe(1)
		expect(io.errors.join("\n")).toContain(
			"wrangler also applied 20260102000000_late.sql, which comb never checked and holds no hash for: check each against git, then run comb migrate baseline <db> --hashes",
		)
		expect(io.errors.join("\n")).not.toContain("see the wrangler output above")
		const reported = JSON.parse(io.outputs.at(-1) as string) as { applied: string[] }
		expect(reported.applied).toEqual(["20260101000000_init.sql", "20260102000000_late.sql"])
		expect(recorded(d1)).toEqual(reported.applied)
	})
})
