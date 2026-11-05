/**
 * A test signals or probes a process by a pid it recorded through tests/support/pid.ts, which knows
 * the process by its start time too. A bare process.kill of a recorded pid lands on whatever later
 * process the kernel gave the pid once the recorded one was reaped: in a pid namespace of its own,
 * .tmp/grunt/p21/areas/pg/pidkill/reuse.log shows a sacrificial process given a recorded pid and
 * ended by process.kill of it. The repo's lint refuses every spelling of it in test code, and a
 * spawned kill, which reaches the same pid by another road.
 */
import { describe, expect, it } from "vitest"
import { repoReports } from "./rule-harness.ts"

const KILL = `'process.kill' is restricted from being used. A test signals a pid it recorded through tests/support/pid.ts, which knows the process by its start time; vi.spyOn(process, "kill") stubs it`
const IS_ALIVE = `'isAlive' import from '../../src/migrate/core/cleanup.ts' is restricted from being used by a pattern. A test probes a pid it recorded through tests/support/pid.ts, which knows the process by its start time`
const SPAWNED =
	"a test spawns no kill, pkill or killall of a pid: signal a recorded process through tests/support/pid.ts"

const SPELLINGS = `import { vi } from "vitest"

export function signals(pid: number): unknown[] {
	process.kill(pid)
	process.kill (pid, "SIGTERM")
	process["kill"](pid)
	process.kill.call(process, pid)
	const k = process.kill
	const { kill } = process
	process
		.kill(pid)
	const spy = vi.spyOn(process, "kill").mockImplementation(() => true)
	return [k, kill, spy]
}
`

const SPAWNS = `import * as cp from "node:child_process"
import { exec, execFileSync, execSync, spawn, spawnSync } from "node:child_process"

export function spawns(pid: number): unknown[] {
	return [
		spawnSync("kill", ["-9", String(pid)]),
		spawn("pkill", ["-f", "atlas"]),
		execFileSync("killall", ["sleep"]),
		cp.spawnSync("/bin/kill", [String(pid)]),
		execSync(\`kill \${pid}\`),
		exec("echo stop; kill -TERM 123"),
		spawn("sh", ["-c", \`kill \${pid}\`]),
		spawn("sh", ["-c", "kill -9 $$"]),
		spawnSync("sh", ["-c", "echo said >&2; kill -9 $$"]),
		spawn("sleep", ["30"]),
		execSync("echo skill"),
	]
}
`

const PROBE = `import { isAlive } from "../../src/migrate/core/cleanup.ts"

export const alive = (pid: number): boolean => isAlive(pid)
`

describe("the repo's lint on a test's signal to a process", () => {
	it("refuses every spelling of process.kill in test code, and allows a stub of it", () => {
		const reports = repoReports({
			"packages/core/tests/integration/d1/signals.test.ts": SPELLINGS,
			"packages/core/src/migrate/core/signals.test.ts": SPELLINGS,
			"packages/core/lint/signals.test.ts": SPELLINGS,
			"packages/core/tests/support/signals.ts": SPELLINGS,
		})
		const lines = [4, 5, 6, 7, 8, 9, 10]
		expect(reports).toEqual(
			[
				"packages/core/lint/signals.test.ts",
				"packages/core/src/migrate/core/signals.test.ts",
				"packages/core/tests/integration/d1/signals.test.ts",
				"packages/core/tests/support/signals.ts",
			].flatMap((file) => lines.map((line) => ({ file, line, message: KILL }))),
		)
	})

	it("leaves process.kill to tests/support/pid.ts and to library code", () => {
		const reports = repoReports({
			"packages/core/tests/support/pid.ts": SPELLINGS,
			"packages/core/src/migrate/core/signals.ts": "export const stop = (pid: number): boolean => process.kill(pid)\n",
		})
		expect(reports).toEqual([])
	})

	it("refuses a spawned kill of any pid but the shell's own", () => {
		const file = "packages/core/tests/integration/d1/spawns.test.ts"
		expect(repoReports({ [file]: SPAWNS })).toEqual(
			[6, 7, 8, 9, 10, 11, 12].map((line) => ({ file, line, message: SPAWNED })),
		)
	})

	it("refuses cleanup.ts's probe of a pid outside its own test", () => {
		const reports = repoReports({
			"packages/core/tests/integration/d1/probe.test.ts": PROBE,
			"packages/core/src/migrate/core/cleanup.test.ts": PROBE.replace(
				"../../src/migrate/core/cleanup.ts",
				"./cleanup.ts",
			),
			"packages/core/src/migrate/core/other.test.ts": PROBE.replace(
				"../../src/migrate/core/cleanup.ts",
				"./cleanup.ts",
			),
		})
		expect(reports).toEqual([
			{
				file: "packages/core/src/migrate/core/other.test.ts",
				line: 1,
				message: IS_ALIVE.replace("../../src/migrate/core/cleanup.ts", "./cleanup.ts"),
			},
			{ file: "packages/core/tests/integration/d1/probe.test.ts", line: 1, message: IS_ALIVE },
		])
	})
})
