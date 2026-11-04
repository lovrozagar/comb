/**
 * comb's one cleanup rule (S2, KC5 and PA4 of r22): what a run makes outside itself (a scratch
 * directory, a replay database) is held here until the run lets it go, and SIGINT or SIGTERM runs
 * every step still held before the process ends as the signal would. A scratch directory is named
 * for the process that made it, so a later run removes one a killed process left at once, by
 * whether that process still runs.
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** A step a signal runs, told which signal came */
type Step = (signal: NodeJS.Signals) => unknown

// per-process-constant: what this process holds now
const held = /* @__PURE__ */ new Set<Step>()

/* the signals a held step runs on: a Ctrl-C, and what a supervisor, a container stop or a CI step timeout sends */
const SIGNALS = ["SIGINT", "SIGTERM"] as const

/**
 * Run every held step, then end the process by the signal again, unless the host listens for it too
 * and so ends it its own way. The listener stays from the first hold on: Node drops a signal that
 * comes while its last listener is going, so one removed at each release could lose a Ctrl-C, and
 * the run would go on (to apply, say). With nothing held it ends the process at once, as Node would.
 */
function stop(signal: NodeJS.Signals): void {
	const steps = [...held]
	held.clear()
	void Promise.allSettled(steps.map(async (step) => step(signal))).then(() => {
		if (process.listenerCount(signal) > 1) return
		/* both gone before the signal comes again, so it ends the process */
		for (const each of SIGNALS) process.off(each, stop)
		process.kill(process.pid, signal)
	})
}

/**
 * Hold `step` until the release this returns, so SIGINT and SIGTERM run it before the process ends.
 * The listener is read from the process, not remembered: a host that removed every listener gets it back.
 */
export function hold(step: Step): () => void {
	for (const signal of SIGNALS) if (!process.listeners(signal).includes(stop)) process.on(signal, stop)
	held.add(step)
	return () => void held.delete(step)
}

/* the cleanup of a replay that has made nothing yet */
const NOTHING = async (): Promise<void> => undefined

/**
 * A cleanup whose step runs at most once, set once there is something to clean: a signal before
 * that cleans nothing, and the step set after it still runs
 */
export function onceCleanup(): { run: () => Promise<void>; set: (step: () => Promise<void>) => void } {
	let step = NOTHING
	let ran: Promise<void> | undefined
	return {
		run: () => (ran ??= step()),
		set: (next) => {
			step = next
			ran = undefined
		},
	}
}

/** `body`, with `cleanup` held while it runs */
export async function onSignals<T>(cleanup: () => Promise<void>, body: () => Promise<T>): Promise<T> {
	const release = hold(cleanup)
	try {
		return await body()
	} finally {
		release()
	}
}

/** Whether process `pid` runs: one another user runs answers EPERM, and so runs */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

/** How old a scratch directory with no live pid to read is before a later run removes it: no run holds one this long */
export const SCRATCH_STALE_MS: number = 6 * 60 * 60_000

/**
 * This process's host and pid namespace, as a scratch name carries them beside its pid: a run in
 * another container sharing the temp directory has pids of its own, which this one must never read
 */
export function hostMark(): string {
	let namespace = ""
	try {
		namespace = fs.readlinkSync("/proc/self/ns/pid")
	} catch {
		// reason: no /proc (macOS, Windows), where the host name alone tells one machine's pids from another's
	}
	return createHash("sha256").update(`${os.hostname()}\0${namespace}`).digest("hex").slice(0, 8)
}

/** The pid and host mark a scratch name carries after its prefix, `<pid>-<mark>-` */
const OWNER = /^(\d+)-([0-9a-f]{8})-/

/**
 * Remove the scratch directories named `prefix` in `dir` that killed runs of this user left: one
 * whose process, on this host, is gone, at once; any other only past SCRATCH_STALE_MS. One another
 * user owns, or a live run's, stays.
 */
export function sweepScratch(prefix: string, dir: string = os.tmpdir(), now: number = Date.now()): void {
	const [uid, mark] = [process.getuid?.(), hostMark()]
	for (const name of fs.readdirSync(dir)) {
		if (!name.startsWith(prefix)) continue
		const full = path.join(dir, name)
		const owner = OWNER.exec(name.slice(prefix.length))
		try {
			const stat = fs.statSync(full)
			if (uid !== undefined && stat.uid !== uid) continue
			const gone = owner !== null && owner[2] === mark && !isAlive(Number(owner[1]))
			if (gone || now - stat.mtimeMs > SCRATCH_STALE_MS) fs.rmSync(full, { force: true, recursive: true })
		} catch {
			// reason: another run removed it first, or it is not ours to remove; either way nothing is left to do
		}
	}
}

// per-process-constant: the prefixes this process swept, each once, at its first scratch
const swept = /* @__PURE__ */ new Set<string>()

/** A directory only this user can open, held until `remove` */
export type Scratch = { dir: string; remove(): void }

/**
 * A new directory under the temp directory that only this user can open (0700), named `prefix`, this
 * process's pid and host mark, and removed by `remove`, or by SIGINT or SIGTERM before it. A
 * process's first scratch of a prefix sweeps what killed runs left.
 */
export function scratchDir(prefix: string): Scratch {
	if (!swept.has(prefix)) {
		swept.add(prefix)
		sweepScratch(prefix)
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}${process.pid}-${hostMark()}-`))
	const rm = () => fs.rmSync(dir, { force: true, recursive: true })
	const release = hold(rm)
	return {
		dir,
		remove: () => {
			release()
			rm()
		},
	}
}
