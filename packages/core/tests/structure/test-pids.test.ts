/**
 * A test that signals or probes a process by a pid it recorded does it through tests/support/pid.ts,
 * which knows the process by its start time too. A bare process.kill of a recorded pid lands on
 * whatever later process the kernel gave the pid once the recorded one was reaped: in a pid
 * namespace of its own, .tmp/grunt/p21/areas/pg/pidkill/reuse.log shows a sacrificial process given
 * a recorded pid and ended by process.kill of it, and the landing run in
 * .tmp/grunt/p21/logs/held-a2.log saw transaction-control.test.ts's Atlas end by a SIGKILL nothing
 * of its own sent.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { runs, see, send, sendGroup } from "../support/pid.ts"

const ROOT = join(import.meta.dirname, "../..")

/** The test code under `dir`: every file of tests/, and the test files of src/ and lint/ */
function testCode(dir: string, all: boolean): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && (all || entry.name.endsWith(".test.ts")))
		.map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
}

/* a signal by pid: process.kill or a bound copy of it, or cleanup.ts's probe, to any pid but the test's own */
const BARE = /\b(?:process\.kill|realKill|isAlive)\(\s*(?!process\.pid\b)/

/* the files that may: pid.ts itself, this test, and cleanup.ts's own test of isAlive, which probes no pid it recorded */
const MAY = new Set(["tests/support/pid.ts", "tests/structure/test-pids.test.ts", "src/migrate/core/cleanup.test.ts"])

const ended = (child: ChildProcess) => new Promise((done) => child.on("exit", (code, end) => done(end ?? code)))

describe("the tests' signals to processes they recorded", () => {
	it("go through tests/support/pid.ts, never a bare process.kill of a recorded pid", () => {
		const files = [
			...testCode(join(ROOT, "tests"), true),
			...testCode(join(ROOT, "src"), false),
			...testCode(join(ROOT, "lint"), false),
		].filter((file) => !MAY.has(file))
		const bare = files.flatMap((file) =>
			readFileSync(join(ROOT, file), "utf8")
				.split("\n")
				.flatMap((line, i) => (BARE.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
		)
		expect(bare).toEqual([])
	})

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
