import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
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
})

describe("run: a process that cannot start", () => {
	it("names the package to install when wrangler or drizzle-kit cannot start", () => {
		const hint = "run comb through a package script, so node_modules/.bin is on PATH, or install"
		const wrangler = run("wrangler", ["--version"], { env: { PATH: "/nonexistent" } })
		expect(wrangler).toEqual({
			code: 127,
			stderr: `wrangler: command not found; ${hint} wrangler (>=4.147.0 <5)`,
			stdout: "",
		})
		const kit = run("bun", ["drizzle-kit", "export"], { cwd: tmpdir() })
		expect(kit.code).toBe(1)
		expect(kit.stderr).toContain(`${hint} drizzle-kit (>=1.0.0-rc.4 <2)`)
	})

	it("reports a file the OS refuses to execute as exit 126 with the reason", () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-process-"))
		try {
			const script = join(dir, "not-executable")
			writeFileSync(script, "#!/bin/sh\necho hi\n", { mode: 0o644 })
			const result = run(script, [])
			expect(result.code).toBe(126)
			expect(result.stderr).toContain(`${script}: `)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("reports output past the buffer limit as its own failure, not as an unrunnable command", () => {
		const result = run("node", ["-e", "process.stdout.write('x'.repeat(1025))"], { maxBuffer: 1024 })
		expect(result).toEqual({ code: 1, stderr: "node: output exceeded 1024 bytes", stdout: "" })
	})

	it("keeps output up to the default limit well past spawnSync's 1 MiB", () => {
		const result = run("node", ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"])
		expect(result.code).toBe(0)
		expect(result.stdout).toHaveLength(2 * 1024 * 1024)
	})

	it("reports a process killed by a signal as 128 + the signal number", () => {
		const result = run("node", ["-e", "process.kill(process.pid, 'SIGTERM')"])
		expect(result.code).toBe(143)
	})
})

/** What a child sees of its environment: COMB_A, whether PATH is there, and its PG* names */
const ENV_OF =
	"process.stdout.write(JSON.stringify({ a: process.env.COMB_A, path: typeof process.env.PATH, pg: Object.keys(process.env).filter((k) => k.startsWith('PG')) }))"
type Seen = { a?: string; path: string; pg: string[] }
const envOf = (env?: Record<string, string | undefined>) =>
	JSON.parse(run("node", ["-e", ENV_OF], { env }).stdout) as Seen

describe("run: the child's environment", () => {
	afterEach(() => vi.unstubAllEnvs())

	it("drops every PG* variable, so a config's connection is the only one a child uses", () => {
		vi.stubEnv("PGSSLMODE", "disable")
		vi.stubEnv("PGPASSWORD", "inherited")
		expect(envOf()).toEqual({ path: "string", pg: [] })
	})

	it("adds env over the rest, and an undefined value removes one", () => {
		vi.stubEnv("COMB_A", "parent")
		expect(envOf({ COMB_A: "child" }).a).toBe("child")
		expect(envOf({ COMB_A: undefined }).a).toBeUndefined()
		expect(envOf({ PGHOST: "set-on-purpose" }).pg).toEqual(["PGHOST"])
	})
})

describe("run: a process a signal stopped", () => {
	it("says which signal stopped it when it printed nothing, rather than fail with an empty reason", () => {
		const result = run("sh", ["-c", "kill -9 $$"])
		expect(result.code).toBe(137)
		expect(result.stderr).toBe("sh was stopped by SIGKILL")
	})

	it("keeps what it printed before the signal", () => {
		const result = run("sh", ["-c", "echo said >&2; kill -9 $$"])
		expect(result.stderr).toBe("said\n")
	})
})
