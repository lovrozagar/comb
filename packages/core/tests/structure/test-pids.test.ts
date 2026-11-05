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
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { recordWhole, runs, see, send, sendGroup } from "../support/pid.ts"

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

describe("the pids a test's child records", () => {
	/*
	 * a child's writeFileSync creates the file before it writes it, so a test waiting for the file
	 * to exist could read it empty: load.test.ts read a grandchild's pid as 0 in run 42083475773
	 */
	it("leave no file half written to a test waiting for it, from a script node or bun runs either way", () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-record-"))
		try {
			const reads = [
				[process.execPath, "-e"],
				[process.execPath, "--input-type=module", "-e"],
				["bun", "-e"],
				[process.execPath, "-e"],
			].map((cmd, i) => {
				const file = join(dir, `pids-${i}.json`)
				/* the last names the path as the child evaluates it, as a stand-in that alone knows its path does */
				const at = i === 3 ? { expression: JSON.stringify(file) } : file
				const [bin, ...flags] = cmd as [string, ...string[]]
				const ran = spawnSync(bin, [...flags, recordWhole(at, "JSON.stringify([process.pid])")], { encoding: "utf8" })
				return [ran.status, (JSON.parse(readFileSync(file, "utf8")) as number[]).length]
			})
			expect(reads).toEqual([
				[0, 1],
				[0, 1],
				[0, 1],
				[0, 1],
			])
			expect(readdirSync(dir).sort()).toEqual(["pids-0.json", "pids-1.json", "pids-2.json", "pids-3.json"])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("are written only through recordWhole: no writeFileSync of a pid anywhere else in the tests or the code", () => {
		expect(pidWriters(sources())).toEqual([])
	})

	it("find a pid written by hand, from a script a test hands its child or in a test's own code", () => {
		/* the call's name split, so these samples are no writers of this file's own */
		const write = ["write", "FileSync"].join("")
		expect(
			pidWriters([
				["a.test.ts", `const s = \`require('fs').${write}(\${JSON.stringify(f)}, String(g.pid))\`\n`],
				["b.test.ts", `fs.${write}(state + ".pid", String(process.pid))\n`],
				["c.test.ts", `fs.${write}(done, "x")\nconst pid = child.pid\n`],
				["tests/support/pid.ts", `fs.${write}(at, String(process.pid))\n`],
			]),
		).toEqual(["a.test.ts:1", "b.test.ts:1"])
	})
})

/* comb's own code, tests and lint rules, where a child's script that records a pid could be written */
const CORE = resolve(import.meta.dirname, "../..")
function sources(): (readonly [string, string])[] {
	return ["src", "tests", "lint"].flatMap((root) =>
		readdirSync(join(CORE, root), { recursive: true, withFileTypes: true })
			.filter((e) => e.isFile() && /\.[cm]?[jt]s$/.test(e.name) && !e.parentPath.includes("node_modules"))
			.map((e) => {
				const path = join(e.parentPath, e.name)
				return [relative(CORE, path), readFileSync(path, "utf8")] as const
			}),
	)
}

/** Each `file:line` that writes a pid by a writeFile call of its own, pid.ts's recordWhole aside */
function pidWriters(files: readonly (readonly [string, string])[]): string[] {
	return files
		.filter(([file]) => file !== "tests/support/pid.ts")
		.flatMap(([file, text]) =>
			text
				.split("\n")
				.flatMap((line, i) =>
					/\b(?:writeFile|appendFile)(?:Sync)?\([^;]*\.pid\b/.test(line) ? [`${file}:${i + 1}`] : [],
				),
		)
}
