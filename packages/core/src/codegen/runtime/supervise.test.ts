import { EventEmitter } from "node:events"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fixtureRoot } from "../__fixtures__/temp.ts"
import { main, supervise } from "./supervise.mjs"

let dir: string

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-supervise-"))
})

afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))

/** Whether a process of `pid` still runs */
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/** A child that starts a sleeping grandchild, writes its pid to `pids`, ignores SIGTERM and never ends */
const stuck = (pids: string) =>
	`const { spawn } = require("node:child_process"); process.on("SIGTERM", () => {}); const g = spawn("sleep", ["600"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pids)}, String(g.pid)); setInterval(() => {}, 1000)`

/** The grandchild's pid, once the child has written it */
async function grandchildOf(pids: string): Promise<number> {
	for (let tries = 0; tries < 100 && !fs.existsSync(pids); tries++) await new Promise((r) => setTimeout(r, 50))
	return Number(fs.readFileSync(pids, "utf8"))
}

describe("supervise: a child in a process group of its own", () => {
	it("answers the child's exit code, and 128 + the signal's number when a signal ended it", async () => {
		expect(await supervise({ args: ["-e", "process.exit(3)"], cmd: process.execPath, timeoutMs: 10_000 }).done).toEqual(
			{ code: 3 },
		)
		expect(
			await supervise({
				args: ["-e", "process.kill(process.pid, 'SIGKILL')"],
				cmd: process.execPath,
				timeoutMs: 10_000,
			}).done,
		).toEqual({
			code: 137,
		})
	})

	it("kills the child's whole group at the timeout, a grandchild that ignores nothing included", async () => {
		const pids = path.join(dir, "pids")
		const run = supervise({ args: ["-e", stuck(pids)], cmd: process.execPath, timeoutMs: 1500 })
		const grandchild = await grandchildOf(pids)
		expect(await run.done).toEqual({ timedOut: true })
		await new Promise((r) => setTimeout(r, 200))
		expect(alive(grandchild)).toBe(false)
	})

	it("kills the group on stop(), and a second stop() of a group already gone is no error", async () => {
		const pids = path.join(dir, "pids")
		const run = supervise({ args: ["-e", stuck(pids)], cmd: process.execPath, timeoutMs: 60_000 })
		const grandchild = await grandchildOf(pids)
		run.stop()
		expect(await run.done).toEqual({ code: 137 })
		run.stop()
		await new Promise((r) => setTimeout(r, 200))
		expect(alive(grandchild)).toBe(false)
	})
})

/** A process stand-in for main: its argv's last entry the job, its exits and signal handlers recorded */
function fakeProcess(job: object) {
	const exits: number[] = []
	const handlers = new Map<string, () => void>()
	return {
		exits,
		handlers,
		proc: {
			argv: ["node", "-e", JSON.stringify(job)],
			exit: ((code: number) => void exits.push(code)) as never,
			on: ((signal: string, handler: () => void) => handlers.set(signal, handler)) as never,
		},
	}
}

describe("main: the supervisor's process", () => {
	it("exits with the child's code, and writes no status", async () => {
		const status = path.join(dir, "status.json")
		const fake = fakeProcess({ args: ["-e", "process.exit(5)"], cmd: process.execPath, status, timeoutMs: 10_000 })
		await main(fake.proc)
		expect(fake.exits).toEqual([5])
		expect(fs.existsSync(status)).toBe(false)
	})

	it("writes the timeout to the status file, then exits 124", async () => {
		const status = path.join(dir, "status.json")
		const fake = fakeProcess({
			args: ["-e", "setInterval(() => {}, 1000)"],
			cmd: process.execPath,
			status,
			timeoutMs: 500,
		})
		await main(fake.proc)
		expect(fake.exits).toEqual([124])
		expect(JSON.parse(fs.readFileSync(status, "utf8"))).toEqual({ timedOut: true })
	})

	it("turns SIGHUP, SIGINT and SIGTERM into the group's kill, then exits 128 + the signal's number", async () => {
		const pids = path.join(dir, "pids")
		const fake = fakeProcess({
			args: ["-e", stuck(pids)],
			cmd: process.execPath,
			status: path.join(dir, "s"),
			timeoutMs: 60_000,
		})
		const ended = main(fake.proc)
		expect([...fake.handlers.keys()].toSorted()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"])
		const grandchild = await grandchildOf(pids)
		fake.handlers.get("SIGINT")?.()
		await ended
		expect(fake.exits[0]).toBe(130)
		await new Promise((r) => setTimeout(r, 200))
		expect(alive(grandchild)).toBe(false)
	})
})

/** A child stand-in with `pid`, which emits `events` once the supervisor listens */
function fakeChild(pid: number | undefined, events: Array<[string, ...unknown[]]>) {
	const child = Object.assign(new EventEmitter(), { pid })
	queueMicrotask(() => {
		for (const [name, ...args] of events) child.emit(name, ...args)
	})
	return child
}

/* the 0.13.1 review of d67fa44: kill(-0) would signal the supervisor's own group, and kill(-1) every
   process the user owns, so the group is killed only for a child this supervisor saw start */
describe("supervise: which group stop() may kill", () => {
	it.each([
		["pid 0, the supervisor's own group", 0],
		["pid 1, every process the user owns", 1],
		["no pid", undefined],
	])("never calls kill for %s", async (_, pid) => {
		const kill = vi.fn()
		const run = supervise({
			args: [],
			cmd: "cmd",
			kill,
			spawn: () => fakeChild(pid, [["spawn"]]) as never,
			timeoutMs: 60_000,
		})
		await new Promise((r) => setTimeout(r, 0))
		run.stop()
		expect(kill).not.toHaveBeenCalled()
	})

	it("never calls kill for a child that failed to start, and answers 127 at once", async () => {
		const kill = vi.fn()
		const run = supervise({
			args: [],
			cmd: "cmd",
			kill,
			spawn: () => fakeChild(4242, [["error", new Error("spawn cmd ENOENT")]]) as never,
			timeoutMs: 60_000,
		})
		expect(await run.done).toEqual({ code: 127 })
		run.stop()
		expect(kill).not.toHaveBeenCalled()
	})

	it("kills the group of a child it saw start, by its negative pid", async () => {
		const kill = vi.fn()
		const run = supervise({
			args: [],
			cmd: "cmd",
			kill,
			spawn: () => fakeChild(4242, [["spawn"]]) as never,
			timeoutMs: 60_000,
		})
		await new Promise((r) => setTimeout(r, 0))
		run.stop()
		expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL")
	})
})
