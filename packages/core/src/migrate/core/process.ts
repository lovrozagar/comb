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
	input?: string | undefined
	/** Bytes of stdout or stderr kept before the process is stopped; default 256 MiB. */
	maxBuffer?: number | undefined
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

/** How a process the OS could not run (or had to stop) is reported: POSIX shell codes where they exist. */
function startFailure(cmd: string, error: NodeJS.ErrnoException, maxBuffer: number): RunResult {
	if (error.code === "ENOENT") return { code: 127, stderr: `${cmd}: command not found`, stdout: "" }
	if (error.code === "ENOBUFS") return { code: 1, stderr: `${cmd}: output exceeded ${maxBuffer} bytes`, stdout: "" }
	return { code: 126, stderr: `${cmd}: ${error.message}`, stdout: "" }
}

/** Runs `cmd` synchronously and reports how it ended; it never throws for a failed command. */
export const run: Run = (cmd, args, options = {}) => {
	const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
	const env = childEnv(options.env)
	const result = spawnSync(cmd, args, { cwd: options.cwd, encoding: "utf8", env, input: options.input, maxBuffer })
	if (result.error !== undefined) return startFailure(cmd, result.error as NodeJS.ErrnoException, maxBuffer)
	const signal = result.signal === null ? 0 : 128 + constants.signals[result.signal]
	return { code: result.status ?? signal, stderr: result.stderr, stdout: result.stdout }
}
