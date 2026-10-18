/**
 * `comb migrate apply` on D1 through wrangler --local (the real binary, a local D1). A migration
 * and the record of its hash go to D1 in one `--file`, which D1 runs all-or-nothing, so nothing
 * can apply a migration without recording it.
 */
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../../src/cli/index.ts"
import { run, type Run } from "../../../src/migrate/core/process.ts"

const WRANGLER = path.join(
	path.dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
	"bin/wrangler.js",
)

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

function project(migrations: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-d1-cli-"))
	dirs.push(dir)
	fs.writeFileSync(
		path.join(dir, "wrangler.toml"),
		'name = "probe"\ncompatibility_date = "2026-10-01"\n\n[[d1_databases]]\nbinding = "CORE"\ndatabase_name = "core"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\n',
	)
	fs.mkdirSync(path.join(dir, "atlas-migrations"))
	for (const [name, sql] of Object.entries(migrations)) fs.writeFileSync(path.join(dir, "atlas-migrations", name), sql)
	return dir
}

/** wrangler from node_modules, run in the project; `fail` makes a matching call fail as a crash would */
function wrangler(dir: string, fail: (args: readonly string[]) => boolean = () => false): Run {
	return (cmd, args, options) => {
		if (cmd !== "wrangler") return run(cmd, args, options)
		if (fail(args)) return { code: 1, stderr: "simulated crash", stdout: "" }
		return run(process.execPath, [WRANGLER, ...args], { ...options, cwd: dir })
	}
}

/** Matches a wrangler call that records a migration hash in its own --command, apart from the migration */
const recordsApart = (args: readonly string[]) =>
	args.some((a) => a.startsWith("--command=") && a.includes("INSERT INTO __drizzle_migrations"))

function io(dir: string, exec: Run) {
	const out: string[] = []
	const err: string[] = []
	return {
		cwd: dir,
		err: (line: string) => err.push(line),
		errors: err,
		out: (line: string) => out.push(line),
		outputs: out,
		run: exec,
	}
}

describe("migrate apply on D1, --local (S-13, plan 5.4)", () => {
	it("applies and records a migration in one wrangler run, so a failed separate record cannot re-apply it", async () => {
		const dir = project({ "20260101000000_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY);" })
		const first = io(dir, wrangler(dir, recordsApart))
		expect(await runCli(["migrate", "apply", "core", "--local"], first)).toBe(0)
		const again = io(dir, wrangler(dir))
		expect(await runCli(["migrate", "apply", "core", "--local"], again)).toBe(0)
		expect(again.outputs.join("\n")).toContain("Skip (already applied): 20260101000000_init.sql")
	}, 120_000)

	it("applies none of a migration that fails partway, and records nothing", async () => {
		const dir = project({ "20260101000000_bad.sql": "CREATE TABLE post (id TEXT);\nINSERT INTO missing VALUES (1);" })
		expect(await runCli(["migrate", "apply", "core", "--local"], io(dir, wrangler(dir)))).toBe(1)
		/* nothing of the failed file stayed or was recorded: once fixed, it applies from scratch */
		const check = io(dir, wrangler(dir))
		fs.writeFileSync(path.join(dir, "atlas-migrations", "20260101000000_bad.sql"), "CREATE TABLE post (id TEXT);")
		expect(await runCli(["migrate", "apply", "core", "--local"], check)).toBe(0)
		expect(check.outputs.join("\n")).toContain("Apply: 20260101000000_bad.sql")
	}, 120_000)
})

describe("migrate baseline on D1, --local", () => {
	it("records every migration as applied without running it, so apply then skips it", async () => {
		const dir = project({ "20260101000000_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY);" })
		const baseline = io(dir, wrangler(dir))
		expect(await runCli(["migrate", "baseline", "core", "--local"], baseline)).toBe(0)
		expect(baseline.outputs.join("\n")).toContain("Marked applied: 20260101000000_init.sql")

		const apply = io(dir, wrangler(dir))
		expect(await runCli(["migrate", "apply", "core", "--local"], apply)).toBe(0)
		expect(apply.outputs.join("\n")).toContain("Skip (already applied): 20260101000000_init.sql")

		/* the SQL itself never ran: the table it creates is absent */
		const tables = run(
			process.execPath,
			[
				WRANGLER,
				"d1",
				"execute",
				"core",
				"--local",
				"--json",
				"--command=SELECT name FROM sqlite_master WHERE type = 'table'",
			],
			{ cwd: dir },
		)
		expect(tables.stdout).not.toContain('"post"')
		expect(tables.stdout).toContain("__drizzle_migrations")
	}, 120_000)
})
