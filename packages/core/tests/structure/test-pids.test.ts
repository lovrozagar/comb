/**
 * A test that signals or probes a process by a pid it recorded does it through tests/support/pid.ts,
 * which knows the process by its start time too. A bare process.kill of a recorded pid lands on
 * whatever later process the kernel gave the pid once the recorded one was reaped: in a pid
 * namespace of its own, .tmp/grunt/p21/areas/pg/pidkill/reuse.log shows a sacrificial process given
 * a recorded pid and ended by process.kill of it, and the landing run in
 * .tmp/grunt/p21/logs/held-a2.log saw transaction-control.test.ts's Atlas end by a SIGKILL nothing
 * of its own sent. The repo's lint refuses the bare forms (lint/test-signals.test.ts); these tests
 * hold pid.ts to knowing a recorded process from a later one.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import { runs, see, send, sendGroup } from "../support/pid.ts"

const ended = (child: ChildProcess) => new Promise((done) => child.on("exit", (code, end) => done(end ?? code)))

describe("the tests' signals to processes they recorded", () => {
	it("reach no later process the kernel gives a recorded pid", async () => {
		const first = spawn("sleep", ["30"], { stdio: "ignore" })
		const seen = see(first.pid as number)
		expect(seen?.pid).toBe(first.pid)
		/* past the start's grain, a clock tick on Linux and a second for ps elsewhere, as a pid the kernel hands out again starts long after */
		await new Promise((done) => setTimeout(done, 1100))
		const later = spawn("sleep", ["30"], { stdio: "ignore" })
		try {
			/* `later` as it would be had the kernel given it `first`'s pid: the pid names a process of another start */
			const reused = { pid: later.pid as number, started: String(seen?.started) }
			expect([runs(reused), send(reused, "SIGKILL")]).toEqual([false, false])
			expect(send(seen as NonNullable<typeof seen>, "SIGKILL")).toBe(true)
			expect(await ended(first)).toBe("SIGKILL")
			expect([runs(seen as NonNullable<typeof seen>), send(seen as NonNullable<typeof seen>, "SIGKILL")]).toEqual([
				false,
				false,
			])
			expect(runs(see(later.pid as number) as NonNullable<ReturnType<typeof see>>)).toBe(true)
		} finally {
			later.kill("SIGKILL")
			await ended(later)
		}
	})

	it("see a pid only as the child of the parent given, and no pid that names no process", () => {
		expect(see(process.pid, process.ppid)?.pid).toBe(process.pid)
		expect([see(process.pid, process.pid), see(0), see(1), see(Number.NaN), see(2 ** 30)]).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		])
	})

	it("signal a child's group only while Node has not reaped the child", async () => {
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
		const end = ended(child)
		expect(sendGroup(child, "SIGTERM")).toBe(true)
		expect(await end).toBe("SIGTERM")
		expect(sendGroup(child, "SIGTERM")).toBe(false)
	})
})
