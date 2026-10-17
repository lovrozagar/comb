/**
 * The one place comb starts a process. Everything that shells out (atlas, wrangler,
 * drizzle-kit) takes a `Run`, so tests pass a fake and the real one is tested here.
 */
import { spawnSync } from "node:child_process"
import { constants } from "node:os"

export type RunResult = { code: number; stdout: string; stderr: string }

export type RunOptions = {
	cwd?: string | undefined
	input?: string | undefined
	/** Bytes of stdout or stderr kept before the process is stopped; default 256 MiB. */
	maxBuffer?: number | undefined
}

export type Run = (cmd: string, args: readonly string[], options?: RunOptions) => RunResult

/* `wrangler d1 execute --json` on a large SELECT or `drizzle-kit export` of a big schema
 * passes spawnSync's 1 MiB default */
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024

/** How a process the OS could not run (or had to stop) is reported: POSIX shell codes where they exist. */
function startFailure(cmd: string, error: NodeJS.ErrnoException, maxBuffer: number): RunResult {
	if (error.code === "ENOENT") return { code: 127, stderr: `${cmd}: command not found`, stdout: "" }
	if (error.code === "ENOBUFS") return { code: 1, stderr: `${cmd}: output exceeded ${maxBuffer} bytes`, stdout: "" }
	return { code: 126, stderr: `${cmd}: ${error.message}`, stdout: "" }
}

/** Runs `cmd` synchronously and reports how it ended; it never throws for a failed command. */
export const run: Run = (cmd, args, options = {}) => {
	const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
	const result = spawnSync(cmd, args, { cwd: options.cwd, encoding: "utf8", input: options.input, maxBuffer })
	if (result.error !== undefined) return startFailure(cmd, result.error as NodeJS.ErrnoException, maxBuffer)
	const signal = result.signal === null ? 0 : 128 + constants.signals[result.signal]
	return { code: result.status ?? signal, stderr: result.stderr, stdout: result.stdout }
}
