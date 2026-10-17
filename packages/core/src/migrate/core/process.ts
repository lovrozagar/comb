/**
 * The one place comb starts a process. Everything that shells out (atlas, wrangler,
 * drizzle-kit) takes a `Run`, so tests pass a fake and the real one is tested here.
 */
import { spawnSync } from "node:child_process"
import { constants } from "node:os"

export type RunResult = { code: number; stdout: string; stderr: string }

export type RunOptions = { cwd?: string; input?: string }

export type Run = (cmd: string, args: readonly string[], options?: RunOptions) => RunResult

/** Exit code for a process the OS could not start, per POSIX shells: 127 not found, 126 not runnable. */
const START_FAILURE = (error: NodeJS.ErrnoException): number => (error.code === "ENOENT" ? 127 : 126)

/** Runs `cmd` synchronously and reports how it ended; it never throws for a failed command. */
export const run: Run = (cmd, args, options = {}) => {
	const result = spawnSync(cmd, args, { cwd: options.cwd, encoding: "utf8", input: options.input })
	if (result.error !== undefined) {
		const error = result.error as NodeJS.ErrnoException
		const reason = error.code === "ENOENT" ? "command not found" : error.message
		return { code: START_FAILURE(error), stderr: `${cmd}: ${reason}`, stdout: "" }
	}
	const signal = result.signal === null ? 0 : 128 + constants.signals[result.signal]
	return { code: result.status ?? signal, stderr: result.stderr, stdout: result.stdout }
}
