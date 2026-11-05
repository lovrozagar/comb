/**
 * The processes a test signals or probes by a pid it recorded. Once such a process ends and is
 * reaped, the kernel may hand its pid to any later process, another test's Atlas among them, so a
 * bare process.kill of the recorded pid can land on that one (transaction-control.test.ts's Atlas
 * stopped by SIGKILL in .tmp/grunt/p21/logs/held-a2.log; the reuse itself in
 * .tmp/grunt/p21/areas/pg/pidkill/reuse.log). A process is known here by its pid and its start
 * time together, read while it is known to run, and is signalled or found running only while its
 * pid still names a process that started then. tests/structure/test-pids.test.ts holds the tests
 * to signalling recorded pids only through here.
 */
import type { ChildProcess } from "node:child_process"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

/** A process a test saw run: its pid and when it started, which no later process given the pid shares */
export type Seen = { readonly pid: number; readonly started: string }

/* process.kill as the OS answers it, bound before any test stubs it */
const realKill = process.kill.bind(process)

/* the platform as this loads, before a test stands in another (process.stop.test.ts's Windows), so a process seen reads the same after */
const LINUX = process.platform === "linux"

/**
 * `pid`'s parent and start time as the OS reads them now, or undefined when no process has the pid:
 * on Linux /proc's start time in clock ticks since boot, elsewhere ps's start to the second
 */
function stat(pid: number): { parent: number; started: string } | undefined {
	if (LINUX) {
		let text: string
		try {
			text = readFileSync(`/proc/${pid}/stat`, "utf8")
		} catch {
			return undefined
		}
		/* the fields after the command's name, which may itself hold spaces and parentheses: state, ppid, … starttime (field 22) */
		const fields = text.slice(text.lastIndexOf(")") + 2).split(" ")
		return { parent: Number(fields[1]), started: String(fields[19]) }
	}
	const read = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(
		spawnSync("ps", ["-o", "ppid=,lstart=", "-p", String(pid)], { encoding: "utf8" }).stdout,
	)
	return read === null ? undefined : { parent: Number(read[1]), started: String(read[2]) }
}

/**
 * The process `pid` names now, or undefined when none runs, or, given `parent`, when the one that
 * runs is not `parent`'s child: a pid a child wrote of itself or of its own child is read while that
 * child's parent holds it, so it names that process and no later one
 */
export function see(pid: number, parent?: number): Seen | undefined {
	/* pid 0 or 1, or no number, would name this test's own group, init, or nothing */
	if (!Number.isInteger(pid) || pid <= 1) return undefined
	const now = stat(pid)
	if (now === undefined || (parent !== undefined && now.parent !== parent)) return undefined
	return { pid, started: now.started }
}

/** The process `pid` names now, as `see` reads it, or an error naming the pid when none runs as it says */
export function running(pid: number, parent?: number): Seen {
	const seen = see(pid, parent)
	if (seen === undefined) throw new Error(`no process ${pid}${parent === undefined ? "" : ` of parent ${parent}`} runs`)
	return seen
}

/**
 * Whether `seen` still runs, a zombie not yet reaped included: its pid names a process that started
 * when it did; undefined, a process `see` found gone, runs no more
 */
export function runs(seen: Seen | undefined): boolean {
	return seen !== undefined && stat(seen.pid)?.started === seen.started
}

/**
 * The source a child runs to record `text`, a JavaScript expression it evaluates, in `file` whole:
 * writeFileSync creates a file before it writes it, so a test that waits for the file to exist may
 * read it empty (load.test.ts read a grandchild's pid as 0 in CI run 42083475773). It writes beside
 * the file, then renames into it, which no reader sees half done. It runs in a CommonJS or module
 * script, under node or bun, as it reaches fs by process.getBuiltinModule. `file` is the path, or
 * `{ expression }`, the JavaScript the child evaluates for a path only it knows. A test writes a pid
 * file only through here: test-pids.test.ts fails a writeFileSync of a pid anywhere else.
 */
export function recordWhole(file: string | { readonly expression: string }, text: string): string {
	const at = typeof file === "string" ? JSON.stringify(file) : file.expression
	return `{ const fs = process.getBuiltinModule("node:fs"); const at = ${at}; fs.writeFileSync(at + ".part", ${text}); fs.renameSync(at + ".part", at) }`
}

/** Sends `signal` to `seen` while it runs, and answers whether it did; a later process given its pid gets nothing */
export function send(seen: Seen | undefined, signal: NodeJS.Signals): boolean {
	if (seen === undefined || !runs(seen)) return false
	try {
		realKill(seen.pid, signal)
		return true
	} catch {
		return false
	}
}

/**
 * Sends `signal` to the process group `child` leads, while Node has not reaped `child`: Node reaps a
 * child only on its own event loop, so a child it holds unreaped still owns its pid and its group's
 */
export function sendGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return false
	realKill(-child.pid, signal)
	return true
}
