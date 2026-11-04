/** A worker project on a local D1 through the real wrangler, and the CLI run on it: the D1 migrate suites' harness */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { run, type Run } from "../../../src/migrate/core/process.ts"

/* the wrangler package comb tests against, which each project installs as a link */
const WRANGLER_PACKAGE = path.dirname(createRequire(import.meta.url).resolve("wrangler/package.json"))
const WRANGLER = path.join(WRANGLER_PACKAGE, "bin/wrangler.js")

const BIN = path.resolve(import.meta.dirname, "../../../src/bin.ts")

/**
 * A worker project whose wrangler.toml applies ./atlas-migrations, holding `migrations` and their
 * atlas.sum, with wrangler installed in it, where comb finds the wrangler it runs (K1 of r22)
 */
export function d1Project(migrations: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-d1-cli-"))
	fs.mkdirSync(path.join(dir, "node_modules"))
	fs.symlinkSync(WRANGLER_PACKAGE, path.join(dir, "node_modules", "wrangler"))
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

/** The CLI as a process of its own in the project, as a user runs it: the project's wrangler, nothing on PATH for it */
export function combProcess(dir: string, args: readonly string[]): Promise<{ code: number | null; stderr: string }> {
	return new Promise((done) => {
		const child = spawn("bun", [BIN, ...args], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] })
		let stderr = ""
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		child.on("close", (code) => done({ code, stderr }))
	})
}

/** wrangler run in the project: the one the CLI resolved, or, called as `wrangler`, the one the tests pin */
export const wrangler =
	(dir: string): Run =>
	(cmd, args, options) => {
		if (options?.peer === "wrangler") return run(cmd, args, { ...options, cwd: dir })
		return cmd === "wrangler" ? run("node", [WRANGLER, ...args], { ...options, cwd: dir }) : run(cmd, args, options)
	}

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
export async function d1Column(dir: string, sql: string): Promise<unknown[]> {
	const ran = await wrangler(dir)("wrangler", ["d1", "execute", "core", "--local", "--json", `--command=${sql}`])
	const [first] = JSON.parse(ran.stdout) as Array<{ results: Array<Record<string, unknown>> }>
	return (first?.results ?? []).map((row) => Object.values(row)[0])
}
