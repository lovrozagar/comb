/**
 * The one place comb starts a process. Everything that shells out (atlas, wrangler,
 * drizzle-kit) takes a `Run`, so tests pass a fake and the real one is tested here. A process runs
 * asynchronously under comb's one cleanup rule (cleanup.ts, PA4 of r22): SIGINT or SIGTERM to comb
 * goes on to the child, comb waits for its end, and its caller never goes on to the next step. On
 * POSIX the child leads a process group of its own, so a stop reaches what it started too, and one
 * that outlives the stop by killAfterMs is killed with SIGKILL.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { constants, devNull } from "node:os"
import { hold, pastStop } from "./cleanup.ts"
/** An optional peer comb spawns rather than imports */
export type BinPeer = "drizzle-kit" | "wrangler"

/**
 * A bin peer as the project holds it: its package.json, the bin file it names for the peer, and the
 * runtime that runs it, `node` or the executable running comb (process.execPath)
 */
export type ProjectBin = { bin: string; manifest: string; peer: BinPeer; runtime: string }

/** How a process ended, as `Run` resolves it */
export type RunResult = {
	/** The exit code: 0 on success, 128 plus the signal's number when a signal ended it, 124 past `timeoutMs`, 1 past `maxBuffer`, 127 when the command is not found, 126 when it could not start */
	code: number
	/** Everything the process wrote to stdout, as UTF-8 */
	stdout: string
	/** Everything the process wrote to stderr, as UTF-8; on a failure comb made or saw, such as a timeout or a signal, it says what happened */
	stderr: string
}

/**
 * The Atlas releases comb runs on, which comb reads from `atlas version` before a command's first
 * I/O and refuses outside it (PA5 of r22): the floor is the oldest release comb's integration suite
 * passes on, and the next major may change what comb reads from Atlas
 */
export const ATLAS_RANGE = ">=1.2.0 <2"

/** Where Atlas, which no package ships, is installed from */
export const ATLAS_INSTALL = "https://atlasgo.io/getting-started"

/** How `Run` starts a process; every field is optional */
export type RunOptions = {
	/** The folder the process starts in; the parent's when omitted */
	cwd?: string | undefined
	/** Variables set over the parent's environment for the child; an undefined value removes one. */
	env?: Readonly<Record<string, string | undefined>> | undefined
	/** The child's whole environment, none of the parent's, in place of `env` */
	exactEnv?: Readonly<Record<string, string>> | undefined
	/** Bytes of stdout or stderr kept before the process is stopped; default 256 MiB. */
	maxBuffer?: number | undefined
	/** The bin peer the process runs, whose runtime a failure to start names */
	peer?: BinPeer | undefined
	/** Milliseconds before the process is stopped, which answers 124 as timeout(1) does; default none */
	timeoutMs?: number | undefined
	/** Milliseconds a process comb stopped gets to end before SIGKILL, as timeout(1)'s -k gives it; default 10 s */
	killAfterMs?: number | undefined
} & (
	| {
			/** Text written to the child's stdin, which is then closed; closed with nothing written when omitted */
			input?: string | undefined
			/** False or omitted: the child's stdin is closed once `input` is written */
			lifeline?: false | undefined
	  }
	| {
			/** No `input` with a lifeline: the child's stdin is never written */
			input?: undefined
			/**
			 * The child's stdin left open and never written while comb runs, so its end tells the child
			 * comb is gone, however comb ended, a SIGKILL included
			 */
			lifeline: true
	  }
)

/**
 * How comb starts a process (atlas, wrangler, drizzle-kit): `cmd` with `args`, no shell. It resolves
 * with the process's end, a failed or unstartable command among them, and never rejects for one.
 */
export type Run = (cmd: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>

/* `wrangler d1 execute --json` on a large SELECT or `drizzle-kit export` of a big schema
 * passes Node's 1 MiB default */
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024

/* a child that traps SIGTERM would hold comb past any stop: this long, then SIGKILL */
const DEFAULT_KILL_AFTER_MS = 10_000

/*
 * On POSIX a child is the leader of a process group of its own, which every stop signals whole: wrangler
 * starts workerd and drizzle-kit esbuild, which a signal to the child alone would leave running. The
 * group gets no terminal's Ctrl-C, so comb's forward is its only signal. Windows has no groups to name.
 */
const GROUPS = process.platform !== "win32"

/* process.kill as the OS answers it, bound as this module loads, so a stand-in a host installs later never takes a child's stop */
const killProcess = /* @__PURE__ */ process.kill.bind(process)

/** `signal` to `child` and, on POSIX, every process of its group */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid
	if (!GROUPS || pid === undefined) {
		child.kill(signal)
		return
	}
	try {
		killProcess(-pid, signal)
	} catch {
		// reason: the group has ended already, which is what stopping it asks for
	}
}

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

/** How a process the OS could not start is reported: POSIX shell codes where they exist. */
function startFailure(cmd: string, error: NodeJS.ErrnoException, peer: BinPeer | undefined): RunResult {
	if (error.code === "ENOENT")
		return { code: 127, stderr: `${cmd}: command not found${installHint(cmd, peer)}`, stdout: "" }
	return { code: 126, stderr: `${cmd}: ${error.message}`, stdout: "" }
}

/** A stream's bytes, kept up to `limit`; `over` once one more came */
function collect(stream: NodeJS.ReadableStream, limit: number, over: () => void): () => string {
	const chunks: Buffer[] = []
	let size = 0
	stream.on("data", (chunk: Buffer) => {
		size += chunk.length
		if (size > limit) return over()
		chunks.push(chunk)
	})
	return () => Buffer.concat(chunks).toString("utf8")
}

/** How the child ended: its code, or 128 + the signal that stopped it, or the stop comb made (124 past timeoutMs, 1 past maxBuffer) */
type Ending = { code: number | null; signal: NodeJS.Signals | null; stopped?: RunResult | undefined }

/**
 * The stops of `child`, which runs `name`: each signals its group, and the first holds its end to
 * killAfterMs, past which SIGKILL ends it; `ended` clears that and says what comb did when it came
 */
function stopsOf(child: ChildProcess, name: string, killAfterMs: number) {
	let first: { signal: NodeJS.Signals; timer: NodeJS.Timeout } | undefined
	let killed = false
	return {
		ended(): string | undefined {
			clearTimeout(first?.timer)
			return killed && first !== undefined
				? `${name} did not end ${killAfterMs} ms after ${first.signal}: comb killed it with SIGKILL`
				: undefined
		},
		stop(signal: NodeJS.Signals): void {
			signalTree(child, signal)
			first ??= {
				signal,
				timer: setTimeout(() => {
					killed = true
					signalTree(child, "SIGKILL")
				}, killAfterMs),
			}
		},
	}
}

/**
 * `cmd` started, and the result of its end; the child is held so a signal to comb stops it first.
 * A stop names the peer `cmd` runs, the process the user knows, or else `cmd` (D5-4 of the area D
 * round-five review).
 */
function started(cmd: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
	const name = options.peer ?? cmd
	const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
	const env = options.exactEnv === undefined ? childEnv(options.env) : { ...options.exactEnv }
	const child = spawn(cmd, args, { cwd: options.cwd, detached: GROUPS, env, stdio: ["pipe", "pipe", "pipe"] })
	const stops = stopsOf(child, name, options.killAfterMs ?? DEFAULT_KILL_AFTER_MS)
	let stopped: RunResult | undefined
	const stopFor = (result: RunResult) => {
		stopped ??= result
		stops.stop("SIGTERM")
	}
	const over = () => stopFor({ code: 1, stderr: `${name}: output exceeded ${maxBuffer} bytes`, stdout: "" })
	const [stdout, stderr] = [collect(child.stdout, maxBuffer, over), collect(child.stderr, maxBuffer, over)]
	const timer =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(
					() => stopFor({ code: 124, stderr: `${name}: stopped after ${options.timeoutMs} ms`, stdout: "" }),
					options.timeoutMs,
				)
	/* a child that ends without reading its input closes the pipe: what it did is the result, not the EPIPE */
	child.stdin.on("error", () => undefined)
	if (options.lifeline !== true) child.stdin.end(options.input)
	const ended = new Promise<Ending | NodeJS.ErrnoException>((resolve) => {
		child.on("error", resolve)
		child.on("close", (code, signal) => {
			/* a lifeline's pipe goes with the child, so it holds no handle of comb's past it */
			child.stdin.destroy()
			resolve({ code, signal, stopped })
		})
	})
	/* a signal to comb goes on to the child, and comb waits for its end before it ends itself */
	let forwarded = false
	const release = hold(async (signal) => {
		forwarded = true
		stops.stop(signal)
		await ended
	})
	return ended.then(async (end) => {
		clearTimeout(timer)
		release()
		const killed = stops.ended()
		/* a child a signal's step stopped: no caller reads its result, so the kill is said here; and its caller waits with every other, so it starts nothing next */
		if (forwarded) {
			if (killed !== undefined) process.stderr.write(`${killed}\n`)
			await pastStop()
		}
		if (end instanceof Error) return startFailure(cmd, end, options.peer)
		const result = resultOf(name, end, { stderr: stderr(), stdout: stdout() })
		/* a killed child's stderr is never empty: it is the stop comb made, or it names the signal that ended it */
		return killed === undefined ? result : { ...result, stderr: `${result.stderr}; ${killed}` }
	})
}

/** The result of a child that ran `name` and ended as `end` says */
function resultOf(name: string, end: Ending, said: { stderr: string; stdout: string }): RunResult {
	if (end.stopped !== undefined) return end.stopped
	const signal = end.signal === null ? 0 : 128 + constants.signals[end.signal]
	/* a process a signal stopped before it said anything would fail with an empty reason: name the signal */
	const stderr = end.signal !== null && said.stderr === "" ? `${name} was stopped by ${end.signal}` : said.stderr
	return { code: end.code ?? signal, stderr, stdout: said.stdout }
}

/** Runs `cmd` and reports how it ended; it never rejects for a failed command. Started while a signal stops comb, it waits with the rest. */
export const run: Run = async (cmd, args, options = {}) => {
	await pastStop()
	return started(cmd, args, options)
}

/**
 * What runs `bin`'s peer through `exec`: its runtime on the bin file of the package the project
 * holds, the one comb checked (K1 of r22), never a name looked up on PATH
 */
export const runPeer =
	(exec: Run, bin: ProjectBin) =>
	(args: readonly string[], options: RunOptions = {}): Promise<RunResult> =>
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
