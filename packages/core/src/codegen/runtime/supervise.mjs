/**
 * The supervisor load.ts runs between codegen and its loader child (F43 of the 0.13.0 round). The
 * child runs in a process group of its own, so its whole group, every process a module's pool or
 * worker started, is killed with SIGKILL when the time runs out, when the child exits, or when a
 * signal reaches this supervisor: a terminal's Ctrl-C reaches codegen and the supervisor, never the
 * child's own group. The child also exits when the pipe on its stdin closes, should the supervisor
 * die unseen. A timeout is written to the status file, which codegen reads, as an exit code a module
 * may also use proves nothing. Plain JavaScript, run by node or bun before any hook loads. POSIX
 * only: a negative pid names a process group.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import { constants } from "node:os"

/** The signals that stop the supervisor, each killing the child's group first */
const SIGNALS = /** @type {const} */ (["SIGHUP", "SIGINT", "SIGTERM"])

/**
 * `cmd` with `args` in a process group of its own, its stdout and stderr this process's, its stdin
 * a pipe no one writes; the group killed with SIGKILL after `timeoutMs`, once the child exits, or on
 * `stop()`
 * @param {number} timeoutMs
 * @param {string} cmd
 * @param {readonly string[]} args
 * @returns {{ done: Promise<{ code: number } | { timedOut: true }>, stop: () => void }}
 */
function supervise(timeoutMs, cmd, args) {
	const child = spawn(cmd, args, { detached: true, stdio: ["pipe", "inherit", "inherit"] })
	const stop = () => {
		try {
			process.kill(-(/** @type {number} */ (child.pid)), "SIGKILL")
		} catch {
			// reason: the group is gone already, which is what killing it asks for
		}
	}
	/** @type {Promise<{ code: number } | { timedOut: true }>} */
	const done = new Promise((resolve) => {
		const timer = setTimeout(() => {
			stop()
			resolve({ timedOut: true })
		}, timeoutMs)
		child.on("exit", (code, signal) => {
			clearTimeout(timer)
			/* a module that exits leaves its pool's processes behind: they go with it */
			stop()
			resolve({ code: code ?? 128 + constants.signals[/** @type {NodeJS.Signals} */ (signal)] })
		})
	})
	return { done, stop }
}

/**
 * The supervisor's process, its last argument `{ timeoutMs, status, cmd, args }` as JSON: the
 * child's exit code its own, a timeout written to `status` before exiting 124, and each of SIGNALS
 * turned into the group's kill before exiting 128 + its number
 * @param {Pick<NodeJS.Process, "argv" | "exit" | "on">} proc
 * @returns {Promise<void>}
 */
async function main(proc) {
	const { args, cmd, status, timeoutMs } = JSON.parse(/** @type {string} */ (proc.argv.at(-1)))
	const run = supervise(timeoutMs, cmd, args)
	for (const signal of SIGNALS) {
		proc.on(signal, () => {
			run.stop()
			proc.exit(128 + constants.signals[signal])
		})
	}
	const ended = await run.done
	if ("timedOut" in ended) {
		fs.writeFileSync(status, JSON.stringify({ timedOut: true }))
		proc.exit(124)
	} else proc.exit(ended.code)
}

export { main, supervise }
