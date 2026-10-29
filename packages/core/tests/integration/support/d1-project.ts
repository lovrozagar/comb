/** A worker project on a local D1 through the real wrangler, and the CLI run on it: the D1 migrate suites' harness */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { run, type Run } from "../../../src/migrate/core/process.ts"

const WRANGLER = path.join(
	path.dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
	"bin/wrangler.js",
)

/** A worker project whose wrangler.toml applies ./atlas-migrations, holding `migrations` and their atlas.sum */
export function d1Project(migrations: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-d1-cli-"))
	fs.writeFileSync(
		path.join(dir, "wrangler.toml"),
		'name = "probe"\ncompatibility_date = "2026-10-01"\n\n[[d1_databases]]\nbinding = "CORE"\ndatabase_name = "core"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\nmigrations_dir = "atlas-migrations"\n',
	)
	fs.mkdirSync(path.join(dir, "atlas-migrations"))
	writeMigrations(dir, migrations)
	return dir
}

/** Migration files added to the project, with atlas.sum rehashed */
export function writeMigrations(dir: string, migrations: Record<string, string>): void {
	for (const [name, sql] of Object.entries(migrations)) fs.writeFileSync(path.join(dir, "atlas-migrations", name), sql)
	spawnSync("atlas", ["migrate", "hash", "--dir", `file://${path.join(dir, "atlas-migrations")}`])
}

/** wrangler from node_modules, run in the project */
export const wrangler =
	(dir: string): Run =>
	(cmd, args, options) =>
		cmd === "wrangler" ? run(process.execPath, [WRANGLER, ...args], { ...options, cwd: dir }) : run(cmd, args, options)

/** The CLI's io for a run in the project, wrangler from node_modules, its lines kept */
export function d1Io(dir: string) {
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
export function d1Column(dir: string, sql: string): unknown[] {
	const ran = wrangler(dir)("wrangler", ["d1", "execute", "core", "--local", "--json", `--command=${sql}`])
	const [first] = JSON.parse(ran.stdout) as Array<{ results: Array<Record<string, unknown>> }>
	return (first?.results ?? []).map((row) => Object.values(row)[0])
}
