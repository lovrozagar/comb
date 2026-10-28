/**
 * The parent's half of the runtime read: run codegen's own child (runtime/child.ts) on the
 * runtime codegen runs on, with an environment of PATH, HOME and NODE_OPTIONS only and a minute to
 * finish, under a supervisor (supervise.mjs) that kills the child's whole process group on a timeout
 * or a signal, and read the snapshot it writes. Under node the child loads TypeScript through
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

/* the child's stdin is a pipe its supervisor holds and never writes: its close means the supervisor
   is gone, and the child goes too (F43) */
const WATCH_SUPERVISOR = `process.stdin.on("end", () => process.exit(1)); process.stdin.resume(); `

/** How long the supervisor gets past the child's timeout before codegen stops it in turn */
const SUPERVISOR_GRACE_MS = 10_000

/**
 * The supervisor's arguments on `runtime` (supervise.mjs): it runs `cmd` with `args` as the child,
 * in a group of its own, for `timeoutMs`, and writes a timeout to `status`
 */
function supervisorArgs(
	runtime: "bun" | "node",
	job: { args: readonly string[]; cmd: string; status: string; timeoutMs: number },
): string[] {
	const supervisor = new URL("supervise.mjs", import.meta.url).href
	const script = `const { main } = await import(${JSON.stringify(supervisor)}); await main(process)`
	const head = runtime === "bun" ? ["--no-env-file", "-e"] : ["--input-type=module", "-e"]
	return [...head, script, JSON.stringify(job)]
}

/**
 * The child's arguments on `runtime`: a module script that imports child.ts alone and hands it the
 * rest, so the child loads the reader and nothing of the CLI; under node with the hooks first
 */
function childArgs(runtime: "bun" | "node", rest: readonly string[]): string[] {
	const child = new URL("child.ts", import.meta.url).href
	/* writeSnapshot has written and closed the result file when it returns, so the exit drops nothing; a
	   module's timer or pool would otherwise keep the child alive past it (F42) */
	const script = `${WATCH_SUPERVISOR}const { writeSnapshot } = await import(${JSON.stringify(child)}); await writeSnapshot(process.argv.slice(-2)); process.exit(0)`
	/* bun reads .env and .env.local from the working directory unless told not to (F41) */
	if (runtime === "bun") return ["--no-env-file", "-e", script, ...rest]
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

type LoadOptions = {
	/**
	 * The working directory the module loads in: comb's own, where the app and drizzle-kit run, so a
	 * root-relative read finds what it finds for them (F58); the process's by default
	 */
	cwd?: string | undefined
	run?: Run | undefined
	runtime?: "bun" | "node" | undefined
	/** How long the child may take; LOAD_TIMEOUT_MS unless a test needs less */
	timeoutMs?: number | undefined
}

/** The snapshot of every table `tablesPath` exports; an error naming the file when it cannot be loaded */
function loadSnapshot(tablesPath: string, options: LoadOptions = {}): Snapshot {
	const runtime = options.runtime ?? (process.versions["bun"] === undefined ? "node" : "bun")
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-codegen-"))
	try {
		const result = path.join(dir, "snapshot.json")
		const status = path.join(dir, "status.json")
		const timeoutMs = options.timeoutMs ?? LOAD_TIMEOUT_MS
		const child = { args: childArgs(runtime, [path.resolve(tablesPath), result]), cmd: process.execPath }
		const ran = (options.run ?? defaultRun)(
			process.execPath,
			supervisorArgs(runtime, { ...child, status, timeoutMs }),
			{
				cwd: options.cwd ?? process.cwd(),
				exactEnv: childEnv(),
				timeoutMs: timeoutMs + SUPERVISOR_GRACE_MS,
			},
		)
		/* the supervisor's own word, as a module may exit 124 itself; codegen's stopping the supervisor is one too */
		if (fs.existsSync(status) || ran.code === 124)
			throw new Error(`comb timed out after ${timeoutMs / 1000} s loading ${tablesPath}`)
		if (!fs.existsSync(result))
			throw new Error(`comb could not load ${tablesPath}: ${ran.stderr.trim() || `the loader exited ${ran.code}`}`)
		const read = JSON.parse(fs.readFileSync(result, "utf8")) as { error: string } | { snapshot: Snapshot }
		if ("error" in read) throw new Error(`comb could not load ${tablesPath}: ${read.error}`)
		return read.snapshot
	} finally {
		fs.rmSync(dir, { force: true, recursive: true })
	}
}

export { childArgs, LOAD_TIMEOUT_MS, loadSnapshot, supervisorArgs }
