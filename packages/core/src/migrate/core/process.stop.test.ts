/**
 * How run stops a child (PA4 of r22, comb-9d's read of it): every stop, a timeout's, maxBuffer's or a
 * signal comb forwards, reaches the child's whole process group on POSIX, so a grandchild goes too,
 * and a child that traps SIGTERM is killed with SIGKILL killAfterMs later, which comb reports. Each
 * case bounds itself: past BOUND_MS it kills what it started and fails with the pids it found alive.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type RunResult, run } from "./process.ts"
import { alive, deliver, stubKill, until } from "../../../tests/support/signals.ts"

/* how long a case waits for a stop before it kills what it started and fails: well past killAfterMs, well under vitest's timeout */
const BOUND_MS = 5000

/* process.kill as the OS answers it, bound before any case stubs it, so a bound's SIGKILL lands */
const realKill = process.kill.bind(process)

/* the grace each case gives a child that traps SIGTERM */
const KILL_AFTER_MS = 300

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-run-stop-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/**
 * A child that traps SIGTERM, starts a sleeping grandchild in its own group, writes both pids to
 * `pids`, then writes `out` bytes to stdout and waits
 */
const TRAPPING = (pids: string, out = 0) =>
	`process.on('SIGTERM', () => {}); const g = require('child_process').spawn('sleep', ['600'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, g.pid])); process.stdout.write('x'.repeat(${out})); setInterval(() => {}, 1000)`

/** The child's and grandchild's pids, once the child wrote them */
async function pidsOf(pids: string): Promise<[number, number]> {
	await until(() => existsSync(pids) && readFileSync(pids, "utf8") !== "", "the child's pids")
	return JSON.parse(readFileSync(pids, "utf8")) as [number, number]
}

/** Which of `pids` still run 2 s on; each one left is killed, so a red run leaves nothing */
async function leftOf(pids: readonly number[]): Promise<number[]> {
	for (const deadline = Date.now() + 2000; Date.now() < deadline && pids.some(alive);)
		await new Promise((resolve) => setTimeout(resolve, 50))
	const left = pids.filter(alive)
	for (const pid of left) realKill(pid, "SIGKILL")
	return left
}

/** `result`, once it settles within BOUND_MS; else the child and grandchild are killed and the case fails naming them */
async function bounded<T>(result: Promise<T>, pids: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	const late = new Promise<"late">((resolve) => {
		timer = setTimeout(() => resolve("late"), BOUND_MS)
	})
	const end = await Promise.race([result, late])
	clearTimeout(timer)
	if (end !== "late") return end
	const found = existsSync(pids) ? (JSON.parse(readFileSync(pids, "utf8")) as number[]) : []
	const running = found.filter(alive)
	for (const pid of running) realKill(pid, "SIGKILL")
	throw new Error(`run had not settled ${BOUND_MS} ms into the stop; still running: ${JSON.stringify(running)}`)
}

describe("run stopping a child that traps SIGTERM (PA4 of r22)", () => {
	it.each([
		{
			code: 124,
			limit: { timeoutMs: 300 },
			out: 0,
			stderr: `node: stopped after 300 ms; node did not end ${KILL_AFTER_MS} ms after SIGTERM: comb killed it with SIGKILL`,
			stop: "past timeoutMs",
		},
		{
			code: 1,
			limit: { maxBuffer: 1024 },
			out: 2048,
			stderr: `node: output exceeded 1024 bytes; node did not end ${KILL_AFTER_MS} ms after SIGTERM: comb killed it with SIGKILL`,
			stop: "past maxBuffer",
		},
	])(
		"kills its group with SIGKILL killAfterMs after the stop $stop, and says so",
		async ({ code, limit, out, stderr }) => {
			const pids = join(dir, "pids")
			const result = run("node", ["-e", TRAPPING(pids, out)], { ...limit, killAfterMs: KILL_AFTER_MS })
			const [child, grandchild] = await pidsOf(pids)
			const ended: RunResult = await bounded(result, pids)
			expect([ended.code, ended.stderr, await leftOf([child, grandchild])]).toEqual([code, stderr, []])
		},
	)
})

describe("run stopped by a signal to comb (PA4 of r22)", () => {
	const kill = stubKill()

	it("leaves no process of the child's group, a grandchild it started included", async () => {
		const pids = join(dir, "pids")
		/* the child ends on SIGTERM as node does by default; its sleeping grandchild only goes with the group */
		const script = `const g = require('child_process').spawn('sleep', ['600'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, g.pid])); setInterval(() => {}, 1000)`
		void run("node", ["-e", script])
		const [child, grandchild] = await pidsOf(pids)
		await deliver("SIGTERM")
		await bounded(
			until(() => kill.calls().length > 0, "comb's end"),
			pids,
		)
		expect([await leftOf([child, grandchild]), kill.calls()]).toEqual([[], [[process.pid, "SIGTERM"]]])
	})

	it("passes it to the child's whole group, and kills a child that traps it killAfterMs later, saying so", async () => {
		const pids = join(dir, "pids")
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		try {
			void run("node", ["-e", TRAPPING(pids)], { killAfterMs: KILL_AFTER_MS })
			const [child, grandchild] = await pidsOf(pids)
			await deliver("SIGTERM")
			await bounded(
				until(() => kill.calls().length > 0, "comb's end"),
				pids,
			)
			expect([await leftOf([child, grandchild]), write.mock.calls.map(([text]) => String(text)), kill.calls()]).toEqual(
				[
					[],
					[`node did not end ${KILL_AFTER_MS} ms after SIGTERM: comb killed it with SIGKILL\n`],
					[[process.pid, "SIGTERM"]],
				],
			)
		} finally {
			write.mockRestore()
		}
	})
})

describe("run on Windows, which has no process groups to name (PA4 of r22)", () => {
	it("stops the child alone, as before: a grandchild it started outlives it", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor
		Object.defineProperty(process, "platform", { value: "win32" })
		vi.resetModules()
		try {
			const { run: windowsRun } = await import("./process.ts")
			const pids = join(dir, "pids")
			const script = `const g = require('child_process').spawn('sleep', ['600'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, g.pid])); setInterval(() => {}, 1000)`
			const result = windowsRun("node", ["-e", script], { timeoutMs: 300 })
			const [child, grandchild] = await pidsOf(pids)
			const ended = await bounded(result, pids)
			const outlived = alive(grandchild)
			expect([ended.code, await leftOf([child]), outlived]).toEqual([124, [], true])
		} finally {
			Object.defineProperty(process, "platform", platform)
			vi.resetModules()
			const found = existsSync(join(dir, "pids"))
				? (JSON.parse(readFileSync(join(dir, "pids"), "utf8")) as number[])
				: []
			for (const pid of found.filter(alive)) realKill(pid, "SIGKILL")
		}
	})
})
