/**
 * A scratch app for the e2e suites: its own package.json and files, inside packages/core so its
 * imports of comb, drizzle and zod resolve as an installed app's would, and the `comb` binary run
 * in it the way a user runs it (bun on src/bin.ts).
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { afterAll } from "vitest"

const CORE = join(import.meta.dirname, "../../..")
const BIN = join(CORE, "src/bin.ts")
const WRANGLER = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin/wrangler.js")

export type Run = { status: number; stderr: string; stdout: string }

export type App = {
	dir: string
	/** `comb <args>` in the app */
	comb(...args: string[]): Run
	/** `wrangler <args>` in the app */
	wrangler(...args: string[]): Run
	write(files: Record<string, string>): void
}

const made: string[] = []
afterAll(() => {
	for (const dir of made.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const result = (run: ReturnType<typeof spawnSync>): Run => ({
	status: run.status ?? 1,
	stderr: String(run.stderr),
	stdout: String(run.stdout),
})

/** A fresh app holding `files`, removed after the file's tests; `env` is set over the runner's for `comb` */
export function app(files: Record<string, string>, env: Readonly<Record<string, string>> = {}): App {
	const dir = mkdtempSync(join(CORE, ".e2e-"))
	made.push(dir)
	const write = (more: Record<string, string>) => {
		for (const [path, text] of Object.entries(more)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true })
			writeFileSync(join(dir, path), text)
		}
	}
	write({ "package.json": JSON.stringify({ name: "e2e-app", private: true, type: "module" }), ...files })
	return {
		comb: (...args) =>
			result(spawnSync("bun", [BIN, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } })),
		dir,
		wrangler: (...args) => result(spawnSync(process.execPath, [WRANGLER, ...args], { cwd: dir, encoding: "utf8" })),
		write,
	}
}

/** Throw with the command's output unless it exited 0 */
export function ok(run: Run, what: string): Run {
	if (run.status !== 0) throw new Error(`${what} exited ${run.status}\n${run.stdout}\n${run.stderr}`)
	return run
}

/** The tables, config and migrate config every SQLite e2e app starts from */
export const BLOG = {
	"comb.config.ts": `import { defineCodegenConfig } from "@lovrozagar/comb/codegen"

export default defineCodegenConfig({
	databases: {
		core: { dialect: "sqlite", driver: "d1", output: { default: "./src/db/_gen" }, tables: "./src/db/core.tables.ts" },
	},
})
`,
	"src/db/core.tables.ts": readFileSync(join(import.meta.dirname, "blog-tables.ts"), "utf8"),
}
