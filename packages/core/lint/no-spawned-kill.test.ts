import { describe, expect, it } from "vitest"
import plugin from "./index.js"
import { reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["no-spawned-kill"]
const MESSAGE =
	"a test spawns no kill, pkill or killall of a pid: signal a recorded process through tests/support/pid.ts"
const FILE = "packages/core/tests/integration/d1/spawns.test.ts"

const reports = (code: string) => reportsOf(rule, { [FILE]: code }).map((report) => report.message)

describe("comb/no-spawned-kill", () => {
	it("rejects a kill, pkill or killall spawned, run by a path, or run through exec or a shell", () => {
		const kills = [
			'spawnSync("kill", ["-9", String(pid)])',
			'spawn("pkill", ["-f", "atlas"])',
			'execFile("killall", ["sleep"])',
			'execFileSync("kill", [String(pid)])',
			'cp.spawnSync("/bin/kill", [String(pid)])',
			"execSync(`kill ${pid}`)",
			'exec("echo stop; kill -TERM 123")',
			'spawn("sh", ["-c", `kill ${pid}`])',
			'spawnSync("bash", ["-e", "-c", "sleep 1 && pkill sleep"])',
		]
		expect(kills.map(reports)).toEqual(kills.map(() => [MESSAGE]))
	})

	it("allows a shell's kill of its own $$, other commands, and calls it cannot read", () => {
		const others = [
			'spawn("sh", ["-c", "kill -9 $$"])',
			'spawnSync("sh", ["-c", "echo said >&2; kill -9 $$"])',
			'spawn("sh", ["-e"])',
			'spawn("sh", script)',
			'spawn("sh", ["-c", script])',
			'spawn("sleep", ["30"])',
			'execSync("echo skill")',
			"spawn(command, args)",
			"spawn(9)",
			'run("kill", [String(pid)])',
			'handlers[0]("kill", [])',
			'(() => spawn)()("kill", [])',
			'vi.spyOn(process, "kill")',
			'child.kill("SIGKILL")',
		]
		expect(others.map(reports)).toEqual(others.map(() => []))
	})
})
