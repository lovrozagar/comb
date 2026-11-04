/**
 * The one place comb starts a process. Everything that shells out (atlas, wrangler,
 * drizzle-kit) takes a `Run`, so tests pass a fake and the real one is tested here.
 */
import { spawnSync } from "node:child_process"
import { constants, devNull } from "node:os"
/** An optional peer comb spawns rather than imports */
export type BinPeer = "drizzle-kit" | "wrangler"

/**
 * A bin peer as the project holds it: its package.json, the bin file it names for the peer, and the
 * runtime that runs it, `node` or the executable running comb (process.execPath)
 */
export type ProjectBin = { bin: string; manifest: string; peer: BinPeer; runtime: string }

export type RunResult = { code: number; stdout: string; stderr: string }

/**
 * The Atlas releases comb runs on, which comb reads from `atlas version` before a command's first
 * I/O and refuses outside it (PA5 of r22): the floor is the oldest release comb's integration suite
 * passes on, and the next major may change what comb reads from Atlas
 */
export const ATLAS_RANGE = ">=1.2.0 <2"

/** Where Atlas, which no package ships, is installed from */
export const ATLAS_INSTALL = "https://atlasgo.io/getting-started"

export type RunOptions = {
	cwd?: string | undefined
	/** Variables set over the parent's environment for the child; an undefined value removes one. */
	env?: Readonly<Record<string, string | undefined>> | undefined
	/** The child's whole environment, none of the parent's, in place of `env` */
	exactEnv?: Readonly<Record<string, string>> | undefined
	input?: string | undefined
	/** Bytes of stdout or stderr kept before the process is stopped; default 256 MiB. */
	maxBuffer?: number | undefined
	/** The bin peer the process runs, whose runtime a failure to start names */
	peer?: BinPeer | undefined
	/** Milliseconds before the process is stopped, which answers 124 as timeout(1) does; default none */
	timeoutMs?: number | undefined
}

export type Run = (cmd: string, args: readonly string[], options?: RunOptions) => RunResult

/* `wrangler d1 execute --json` on a large SELECT or `drizzle-kit export` of a big schema
 * passes spawnSync's 1 MiB default */
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024

/**
 * The child's environment: the parent's without any PG* variable, so libpq-style defaults a shell
 * happens to export (PGSSLMODE=disable, PGPASSWORD) never change a connection comb configured, and
 * PGPASSFILE pointed at nothing, so libpq's driver reads no ~/.pgpass the config does not name, as
 * comb's own reads read none (P6 of the 0.15.0 review, P6 of r19); then `env` over it. No
 * PGSERVICEFILE: lib/pq in Atlas before v1.2.0 panics on any, and a service file is read only for a
 * URL naming a service, which comb refuses (PA5 of r22).
 */
function childEnv(env: RunOptions["env"]): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { PGPASSFILE: devNull }
	for (const [name, value] of Object.entries<string | undefined>(process.env))
		if (!name.startsWith("PG")) out[name] = value
	for (const [name, value] of Object.entries(env ?? {})) {
		if (value === undefined) delete out[name]
		else out[name] = value
	}
	return out
}

// lookup-table: each runtime a bin peer is spawned on by name, and where it is installed from; comb's own is its path
const RUNTIMES: Readonly<Record<string, string>> = { node: "Node.js (https://nodejs.org)" }

/** What to do when `cmd` cannot start: Atlas, or a bin peer's runtime, install it; "" for any other command */
function installHint(cmd: string, peer: BinPeer | undefined): string {
	if (cmd === "atlas") return `; install atlas (${ATLAS_RANGE}) from ${ATLAS_INSTALL}`
	if (peer === undefined || !Object.hasOwn(RUNTIMES, cmd)) return ""
	return `; comb runs ${peer} on ${cmd}, and finds no ${cmd} on PATH: install ${RUNTIMES[cmd]}`
}

/** How a process the OS could not run (or had to stop) is reported: POSIX shell codes where they exist. */
function startFailure(cmd: string, error: NodeJS.ErrnoException, options: RunOptions): RunResult {
	const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
	if (error.code === "ETIMEDOUT")
		return { code: 124, stderr: `${cmd}: stopped after ${options.timeoutMs} ms`, stdout: "" }
	if (error.code === "ENOENT")
		return { code: 127, stderr: `${cmd}: command not found${installHint(cmd, options.peer)}`, stdout: "" }
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
	/* a process a signal stopped before it said anything would fail with an empty reason: name the signal */
	const stderr =
		result.signal !== null && result.stderr === "" ? `${cmd} was stopped by ${result.signal}` : result.stderr
	return { code: result.status ?? signal, stderr, stdout: result.stdout }
}

/**
 * What runs `bin`'s peer through `exec`: its runtime on the bin file of the package the project
 * holds, the one comb checked (K1 of r22), never a name looked up on PATH
 */
export const runPeer =
	(exec: Run, bin: ProjectBin) =>
	(args: readonly string[], options: RunOptions = {}): RunResult =>
		exec(bin.runtime, [bin.bin, ...args], { ...asBun(bin, options), peer: bin.peer })

/**
 * `options` for a peer on comb's own Bun, run as bun: in a Bun single-file executable
 * `process.execPath` is the app, which runs its own entry unless `BUN_BE_BUN` is set (D2-4 of the
 * area D round-two review); plain bun and node ignore it
 */
function asBun(bin: ProjectBin, options: RunOptions): RunOptions {
	if (bin.runtime !== process.execPath || process.versions["bun"] === undefined) return options
	const { env, exactEnv } = options
	if (exactEnv !== undefined) return { ...options, exactEnv: { ...exactEnv, BUN_BE_BUN: "1" } }
	return { ...options, env: { ...env, BUN_BE_BUN: "1" } }
}
