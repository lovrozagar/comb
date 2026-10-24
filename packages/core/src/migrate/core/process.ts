/**
 * The one place comb starts a process. Everything that shells out (atlas, wrangler,
 * drizzle-kit) takes a `Run`, so tests pass a fake and the real one is tested here.
 */
import { spawnSync } from "node:child_process"
import { constants } from "node:os"

export type RunResult = { code: number; stdout: string; stderr: string }

export type RunOptions = {
	cwd?: string | undefined
	/** Variables set over the parent's environment for the child; an undefined value removes one. */
	env?: Readonly<Record<string, string | undefined>> | undefined
	/** The child's whole environment, none of the parent's, in place of `env` */
	exactEnv?: Readonly<Record<string, string>> | undefined
	input?: string | undefined
	/** Bytes of stdout or stderr kept before the process is stopped; default 256 MiB. */
	maxBuffer?: number | undefined
	/** Milliseconds before the process is stopped, which answers 124 as timeout(1) does; default none */
	timeoutMs?: number | undefined
}

export type Run = (cmd: string, args: readonly string[], options?: RunOptions) => RunResult

/* `wrangler d1 execute --json` on a large SELECT or `drizzle-kit export` of a big schema
 * passes spawnSync's 1 MiB default */
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024

/**
 * The child's environment: the parent's without any PG* variable, so libpq-style defaults a shell
 * happens to export (PGSSLMODE=disable, PGPASSWORD) never change a connection comb configured,
 * then `env` over it.
 */
function childEnv(env: RunOptions["env"]): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {}
	for (const [name, value] of Object.entries<string | undefined>(process.env))
		if (!name.startsWith("PG")) out[name] = value
	for (const [name, value] of Object.entries(env ?? {})) {
		if (value === undefined) delete out[name]
		else out[name] = value
	}
	return out
}

/* the packages comb runs that a project installs (optional peers), with the range comb is tested against */
const PEERS: Readonly<Record<string, string>> = { "drizzle-kit": ">=1.0.0-rc.4 <2", wrangler: ">=4.147.0 <5" }

/** What to do when the package `name` cannot start, for a package comb knows; "" otherwise */
const installHint = (name: string): string =>
	Object.hasOwn(PEERS, name)
		? `; run comb through a package script, so node_modules/.bin is on PATH, or install ${name} (${PEERS[name]})`
		: ""

/** How a process the OS could not run (or had to stop) is reported: POSIX shell codes where they exist. */
function startFailure(cmd: string, error: NodeJS.ErrnoException, options: RunOptions): RunResult {
	const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
	if (error.code === "ETIMEDOUT")
		return { code: 124, stderr: `${cmd}: stopped after ${options.timeoutMs} ms`, stdout: "" }
	if (error.code === "ENOENT") return { code: 127, stderr: `${cmd}: command not found${installHint(cmd)}`, stdout: "" }
	if (error.code === "ENOBUFS") return { code: 1, stderr: `${cmd}: output exceeded ${maxBuffer} bytes`, stdout: "" }
	return { code: 126, stderr: `${cmd}: ${error.message}`, stdout: "" }
}

/** Runs `cmd` synchronously and reports how it ended; it never throws for a failed command. */
export const run: Run = (cmd, args, options = {}) => {
	const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
	const env = options.exactEnv === undefined ? childEnv(options.env) : { ...options.exactEnv }
	const { cwd, input, timeoutMs: timeout } = options
	const result = spawnSync(cmd, args, { cwd, encoding: "utf8", env, input, maxBuffer, timeout })
	if (result.error !== undefined) return startFailure(cmd, result.error as NodeJS.ErrnoException, options)
	const signal = result.signal === null ? 0 : 128 + constants.signals[result.signal]
	/* `bun <package>` with the package missing says only that the script is not found */
	const missing = cmd === "bun" && result.stderr.includes(`Script not found "${args[0]}"`)
	const said = missing ? `${result.stderr.trimEnd()}${installHint(args[0] as string)}` : result.stderr
	/* a process a signal stopped before it said anything would fail with an empty reason: name the signal */
	const stderr = result.signal !== null && said === "" ? `${cmd} was stopped by ${result.signal}` : said
	return { code: result.status ?? signal, stderr, stdout: result.stdout }
}
