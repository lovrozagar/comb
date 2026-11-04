import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { devNull, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ATLAS_RANGE, run, runPeer } from "./process.ts"

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
	"process.stdout.write(JSON.stringify({ a: process.env.COMB_A, passfile: process.env.PGPASSFILE, path: typeof process.env.PATH, pg: Object.keys(process.env).filter((k) => k.startsWith('PG') && k !== 'PGPASSFILE' && k !== 'PGSERVICEFILE'), servicefile: process.env.PGSERVICEFILE }))"
type Seen = { a?: string; passfile?: string; path: string; pg: string[]; servicefile?: string }
const envOf = (env?: Record<string, string | undefined>) =>
	JSON.parse(run("node", ["-e", ENV_OF], { env }).stdout) as Seen

describe("run: the child's environment", () => {
	afterEach(() => vi.unstubAllEnvs())

	/* the reviewer's reading of P6: libpq's driver reads ~/.pgpass for a URL without a password, a file the config does not name */
	/* PA5 of r22: lib/pq before Atlas v1.2.0 panics on any PGSERVICEFILE, so comb sets none; it drops the parent's, as
	   every PG* variable, and refuses a URL naming a service (atlas-target.ts), so no service file is ever read */
	it("drops every PG* variable, points the passfile at nothing and sets no service file, so a config's connection is the only one a child uses", () => {
		vi.stubEnv("PGSSLMODE", "disable")
		vi.stubEnv("PGPASSWORD", "inherited")
		vi.stubEnv("PGPASSFILE", "/home/someone/.pgpass")
		vi.stubEnv("PGSERVICEFILE", "/home/someone/.pg_service.conf")
		expect(envOf()).toEqual({ passfile: devNull, path: "string", pg: [] })
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

/* codegen loads a tables module in a child that sees none of the parent's secrets, for at most a minute */
describe("run: an exact environment and a timeout", () => {
	afterEach(() => vi.unstubAllEnvs())

	it("gives the child exactEnv alone, none of the parent's variables", () => {
		vi.stubEnv("COMB_SECRET", "parent")
		const script =
			"process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k !== '__CF_USER_TEXT_ENCODING').sort()))"
		const { stdout } = run(process.execPath, ["-e", script], {
			exactEnv: { HOME: "/h", PATH: process.env["PATH"] ?? "" },
		})
		expect(JSON.parse(stdout)).toEqual(["HOME", "PATH"])
	})

	it("stops a child past timeoutMs and answers 124, naming the limit", () => {
		const result = run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 })
		expect(result).toEqual({ code: 124, stderr: `${process.execPath}: stopped after 200 ms`, stdout: "" })
	})
})

/** Runs `body` with `process.versions.bun` as `version`, none for undefined, whatever runtime runs the test */
function onBun(version: string | undefined, body: () => void): void {
	const own = Object.getOwnPropertyDescriptor(process.versions, "bun")
	if (version === undefined) Reflect.deleteProperty(process.versions, "bun")
	else Object.defineProperty(process.versions, "bun", { configurable: true, enumerable: true, value: version })
	try {
		body()
	} finally {
		if (own === undefined) Reflect.deleteProperty(process.versions, "bun")
		else Object.defineProperty(process.versions, "bun", own)
	}
}

describe("runPeer (K1 of r22)", () => {
	/* a bin peer runs on its runtime and the bin the project's package names, never from PATH */
	it("runs a bin peer on its runtime, and names the runtime when it cannot start", () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-process-"))
		try {
			const bin = join(dir, "w.js")
			writeFileSync(bin, "process.stdout.write(process.argv.slice(2).join(' '))")
			const wrangler = { bin, manifest: join(dir, "package.json"), peer: "wrangler", runtime: "node" } as const
			expect(runPeer(run, wrangler)(["d1", "list"])).toEqual({ code: 0, stderr: "", stdout: "d1 list" })
			expect(runPeer(run, wrangler)(["d1"], { env: { PATH: "/nonexistent" } })).toEqual({
				code: 127,
				stderr:
					"node: command not found; comb runs wrangler on node, and finds no node on PATH: install Node.js (https://nodejs.org)",
				stdout: "",
			})
			/* drizzle-kit runs on comb's own runtime, by its path: one that is gone has no install to name */
			const kit = { ...wrangler, peer: "drizzle-kit", runtime: join(dir, "gone", "bun") } as const
			expect(runPeer(run, kit)(["export"]).stderr).toBe(`${join(dir, "gone", "bun")}: command not found`)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("passes the peer it runs to the runner with the spawn", () => {
		const calls: unknown[] = []
		const fake = (cmd: string, args: readonly string[], options?: unknown) => {
			calls.push([cmd, args, options])
			return { code: 0, stderr: "", stdout: "" }
		}
		const kit = {
			bin: "/k/bin.cjs",
			manifest: "/k/package.json",
			peer: "drizzle-kit" as const,
			runtime: process.execPath,
		}
		runPeer(fake, kit)(["export"], { cwd: "/w" })
		expect(calls).toEqual([[process.execPath, ["/k/bin.cjs", "export"], { cwd: "/w", peer: "drizzle-kit" }]])
	})
})

describe("runPeer on comb's own Bun", () => {
	/*
	 * D2-4 of the area D round-two review: in a Bun single-file executable, process.execPath is the
	 * app, which runs its own entry unless BUN_BE_BUN is set, so drizzle-kit would respawn the app
	 */
	it("runs a peer on comb's own Bun as bun, and leaves node and a peer on another runtime as they are", () => {
		const calls: unknown[] = []
		const fake = (cmd: string, args: readonly string[], options?: unknown) => {
			calls.push(options)
			return { code: 0, stderr: "", stdout: "" }
		}
		const kit = {
			bin: "/k/bin.cjs",
			manifest: "/k/package.json",
			peer: "drizzle-kit" as const,
			runtime: process.execPath,
		}
		const wrangler = { ...kit, peer: "wrangler" as const, runtime: "node" }
		onBun("1.3.0", () => {
			runPeer(fake, kit)(["export"], { cwd: "/w", env: { A: "a" } })
			runPeer(fake, kit)(["export"], { exactEnv: { A: "a" } })
			runPeer(fake, wrangler)(["d1"])
		})
		onBun(undefined, () => runPeer(fake, kit)(["export"]))
		expect(calls).toEqual([
			{ cwd: "/w", env: { A: "a", BUN_BE_BUN: "1" }, peer: "drizzle-kit" },
			{ exactEnv: { A: "a", BUN_BE_BUN: "1" }, peer: "drizzle-kit" },
			{ peer: "wrangler" },
			{ peer: "drizzle-kit" },
		])
	})
})

describe("run: Atlas missing (KC6 + PA22 of r22; sibling: a bin peer's runtime)", () => {
	it("names Atlas's range and its install page when atlas cannot start, and no hint for another command", () => {
		expect(run("atlas", ["migrate", "hash"], { env: { PATH: "/nonexistent" } })).toEqual({
			code: 127,
			stderr: `atlas: command not found; install atlas (${ATLAS_RANGE}) from https://atlasgo.io/getting-started`,
			stdout: "",
		})
		expect(run("comb-no-such-command", [], {}).stderr).toBe("comb-no-such-command: command not found")
	})
})
