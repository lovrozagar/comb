/**
 * The parent's half of the runtime read: run codegen's own child (runtime/child.ts) on the
 * runtime codegen runs on, with an environment of PATH, HOME and NODE_OPTIONS only and a minute to
 * finish, and read the snapshot it writes. Under node the child loads TypeScript through
 * node-hooks.mjs; bun loads it itself.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type Run, run as defaultRun } from "../../migrate/core/process.ts"
import type { Snapshot } from "./snapshot-types.ts"

/** How long the child may take to load the tables module */
const LOAD_TIMEOUT_MS = 60_000

/** The child's whole environment: what finds the runtime and its options, no secret of the parent's */
function childEnv(): Record<string, string> {
	const env: Record<string, string> = {}
	for (const name of ["HOME", "NODE_OPTIONS", "PATH"]) {
		const value = process.env[name]
		if (value !== undefined) env[name] = value
	}
	return env
}

/**
 * The child's arguments on `runtime`: a module script that imports child.ts alone and hands it the
 * rest, so the child loads the reader and nothing of the CLI; under node with the hooks first
 */
function childArgs(runtime: "bun" | "node", rest: readonly string[]): string[] {
	const child = new URL("child.ts", import.meta.url).href
	const script = `const { writeSnapshot } = await import(${JSON.stringify(child)}); await writeSnapshot(process.argv.slice(-2))`
	if (runtime === "bun") return ["-e", script, ...rest]
	const hooks = new URL("node-hooks.mjs", import.meta.url).href
	return [
		/* a package import.meta.resolve()s from the file that imports it, a second argument node 22 flags */
		"--experimental-import-meta-resolve",
		"--disable-warning=ExperimentalWarning",
		"--import",
		`data:text/javascript,import{install}from${JSON.stringify(hooks)};install()`,
		"--input-type=module",
		"-e",
		script,
		...rest,
	]
}

type LoadOptions = { run?: Run | undefined; runtime?: "bun" | "node" | undefined }

/** The snapshot of every table `tablesPath` exports; an error naming the file when it cannot be loaded */
function loadSnapshot(tablesPath: string, options: LoadOptions = {}): Snapshot {
	const runtime = options.runtime ?? (process.versions["bun"] === undefined ? "node" : "bun")
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-codegen-"))
	try {
		const result = path.join(dir, "snapshot.json")
		const args = childArgs(runtime, [path.resolve(tablesPath), result])
		const ran = (options.run ?? defaultRun)(process.execPath, args, {
			cwd: path.dirname(path.resolve(tablesPath)),
			exactEnv: childEnv(),
			timeoutMs: LOAD_TIMEOUT_MS,
		})
		if (ran.code === 124) throw new Error(`comb could not load ${tablesPath} within ${LOAD_TIMEOUT_MS / 1000} s`)
		if (!fs.existsSync(result))
			throw new Error(`comb could not load ${tablesPath}: ${ran.stderr.trim() || `the loader exited ${ran.code}`}`)
		const read = JSON.parse(fs.readFileSync(result, "utf8")) as { error: string } | { snapshot: Snapshot }
		if ("error" in read) throw new Error(`comb could not load ${tablesPath}: ${read.error}`)
		return read.snapshot
	} finally {
		fs.rmSync(dir, { force: true, recursive: true })
	}
}

export { childArgs, LOAD_TIMEOUT_MS, loadSnapshot }
