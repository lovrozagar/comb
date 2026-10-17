import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { run } from "./process.ts"

describe("run", () => {
	it("returns the exit code and both streams", () => {
		const result = run("node", ["-e", "process.stdout.write('out'); process.stderr.write('err')"])
		expect(result).toEqual({ code: 0, stderr: "err", stdout: "out" })
	})

	it("reports a nonzero exit without throwing", () => {
		const result = run("node", ["-e", "process.stderr.write('boom'); process.exit(3)"])
		expect(result).toEqual({ code: 3, stderr: "boom", stdout: "" })
	})

	it("runs in cwd and feeds input to stdin", () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-run-"))
		try {
			const script = "process.stdin.on('data', (d) => process.stdout.write(process.cwd() + ':' + d))"
			const result = run("node", ["-e", script], { cwd: dir, input: "hi" })
			expect(result).toEqual({ code: 0, stderr: "", stdout: `${realpathSync(dir)}:hi` })
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("reports a missing binary as exit 127 with the reason on stderr", () => {
		const result = run("comb-no-such-binary", ["x"])
		expect(result.code).toBe(127)
		expect(result.stdout).toBe("")
		expect(result.stderr).toBe("comb-no-such-binary: command not found")
	})

	it("reports a process killed by a signal as 128 + the signal number", () => {
		const result = run("node", ["-e", "process.kill(process.pid, 'SIGTERM')"])
		expect(result.code).toBe(143)
	})
})
