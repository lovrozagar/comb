import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { devNull, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ATLAS_RANGE, run, runPeer } from "./process.ts"
import { onBun } from "../../../tests/support/runtime.ts"
import { recordWhole, running, runs } from "../../../tests/support/pid.ts"
import { deliver, stubKill, until } from "../../../tests/support/signals.ts"

describe("run", () => {
	it("returns the exit code and both streams", async () => {
		const result = await run("node", ["-e", "process.stdout.write('out'); process.stderr.write('err')"])
		expect(result).toEqual({ code: 0, stderr: "err", stdout: "out" })
	})

	it("reports a nonzero exit without throwing", async () => {
		const result = await run("node", ["-e", "process.stderr.write('boom'); process.exit(3)"])
		expect(result).toEqual({ code: 3, stderr: "boom", stdout: "" })
	})

	it("runs in cwd and feeds input to stdin", async () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-run-"))
		try {
			const script = "process.stdin.on('data', (d) => process.stdout.write(process.cwd() + ':' + d))"
			const result = await run("node", ["-e", script], { cwd: dir, input: "hi" })
			expect(result).toEqual({ code: 0, stderr: "", stdout: `${realpathSync(dir)}:hi` })
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("reports a missing binary as exit 127 with the reason on stderr", async () => {
		const result = await run("comb-no-such-binary", ["x"])
		expect(result.code).toBe(127)
		expect(result.stdout).toBe("")
		expect(result.stderr).toBe("comb-no-such-binary: command not found")
	})
})

describe("run: a process that cannot start", () => {
	it("reports a file the OS refuses to execute as exit 126 with the reason", async () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-process-"))
		try {
			const script = join(dir, "not-executable")
			writeFileSync(script, "#!/bin/sh\necho hi\n", { mode: 0o644 })
			const result = await run(script, [])
			expect(result.code).toBe(126)
			expect(result.stderr).toContain(`${script}: `)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("reports output past the buffer limit as its own failure, not as an unrunnable command", async () => {
		const result = await run("node", ["-e", "process.stdout.write('x'.repeat(1025))"], { maxBuffer: 1024 })
		expect(result).toEqual({ code: 1, stderr: "node: output exceeded 1024 bytes", stdout: "" })
	})

	it("keeps output up to the default limit well past spawnSync's 1 MiB", async () => {
		const result = await run("node", ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"])
		expect(result.code).toBe(0)
		expect(result.stdout).toHaveLength(2 * 1024 * 1024)
	})

	it("reports a process killed by a signal as 128 + the signal number", async () => {
		const result = await run("node", ["-e", "process.kill(process.pid, 'SIGTERM')"])
		expect(result.code).toBe(143)
	})
})

/** What a child sees of its environment: COMB_A, whether PATH is there, and its PG* names */
const ENV_OF =
	"process.stdout.write(JSON.stringify({ a: process.env.COMB_A, passfile: process.env.PGPASSFILE, path: typeof process.env.PATH, pg: Object.keys(process.env).filter((k) => k.startsWith('PG') && k !== 'PGPASSFILE' && k !== 'PGSERVICEFILE'), servicefile: process.env.PGSERVICEFILE }))"
type Seen = { a?: string; passfile?: string; path: string; pg: string[]; servicefile?: string }
const envOf = async (env?: Record<string, string | undefined>) =>
	JSON.parse((await run("node", ["-e", ENV_OF], { env })).stdout) as Seen

describe("run: the child's environment", () => {
	afterEach(() => vi.unstubAllEnvs())

	/* the reviewer's reading of P6: libpq's driver reads ~/.pgpass for a URL without a password, a file the config does not name */
	/* PA5 of r22: lib/pq before Atlas v1.2.0 panics on any PGSERVICEFILE, so comb sets none; it drops the parent's, as
	   every PG* variable, and refuses a URL naming a service (atlas-target.ts), so no service file is ever read */
	it("drops every PG* variable, points the passfile at nothing and sets no service file, so a config's connection is the only one a child uses", async () => {
		vi.stubEnv("PGSSLMODE", "disable")
		vi.stubEnv("PGPASSWORD", "inherited")
		vi.stubEnv("PGPASSFILE", "/home/someone/.pgpass")
		vi.stubEnv("PGSERVICEFILE", "/home/someone/.pg_service.conf")
		expect(await envOf()).toEqual({ passfile: devNull, path: "string", pg: [] })
	})

	it("adds env over the rest, and an undefined value removes one", async () => {
		vi.stubEnv("COMB_A", "parent")
		expect((await envOf({ COMB_A: "child" })).a).toBe("child")
		expect((await envOf({ COMB_A: undefined })).a).toBeUndefined()
		expect((await envOf({ PGHOST: "set-on-purpose" })).pg).toEqual(["PGHOST"])
	})
})

describe("run: a process a signal stopped", () => {
	it("says which signal stopped it when it printed nothing, rather than fail with an empty reason", async () => {
		const result = await run("sh", ["-c", "kill -9 $$"])
		expect(result.code).toBe(137)
		expect(result.stderr).toBe("sh was stopped by SIGKILL")
	})

	it("keeps what it printed before the signal", async () => {
		const result = await run("sh", ["-c", "echo said >&2; kill -9 $$"])
		expect(result.stderr).toBe("said\n")
	})
})

/* codegen loads a tables module in a child that sees none of the parent's secrets, for at most a minute */
describe("run: an exact environment and a timeout", () => {
	afterEach(() => vi.unstubAllEnvs())

	it("gives the child exactEnv alone, none of the parent's variables", async () => {
		vi.stubEnv("COMB_SECRET", "parent")
		const script =
			"process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k !== '__CF_USER_TEXT_ENCODING').sort()))"
		const { stdout } = await run(process.execPath, ["-e", script], {
			exactEnv: { HOME: "/h", PATH: process.env["PATH"] ?? "" },
		})
		expect(JSON.parse(stdout)).toEqual(["HOME", "PATH"])
	})

	it("stops a child past timeoutMs and answers 124, naming the limit", async () => {
		const result = await run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 })
		expect(result).toEqual({ code: 124, stderr: `${process.execPath}: stopped after 200 ms`, stdout: "" })
	})
})

describe("runPeer (K1 of r22)", () => {
	/* a bin peer runs on its runtime and the bin the project's package names, never from PATH */
	it("runs a bin peer on its runtime, and names the runtime when it cannot start", async () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-process-"))
		try {
			const bin = join(dir, "w.js")
			writeFileSync(bin, "process.stdout.write(process.argv.slice(2).join(' '))")
			const wrangler = { bin, manifest: join(dir, "package.json"), peer: "wrangler", runtime: "node" } as const
			expect(await runPeer(run, wrangler)(["d1", "list"])).toEqual({ code: 0, stderr: "", stdout: "d1 list" })
			expect(await runPeer(run, wrangler)(["d1"], { env: { PATH: "/nonexistent" } })).toEqual({
				code: 127,
				stderr:
					"node: command not found; comb runs wrangler on node, and finds no node on PATH: install Node.js (https://nodejs.org)",
				stdout: "",
			})
			/* drizzle-kit runs on comb's own runtime, by its path: one that is gone has no install to name */
			const kit = { ...wrangler, peer: "drizzle-kit", runtime: join(dir, "gone", "bun") } as const
			expect((await runPeer(run, kit)(["export"])).stderr).toBe(`${join(dir, "gone", "bun")}: command not found`)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("passes the peer it runs to the runner with the spawn", async () => {
		const calls: unknown[] = []
		const fake = async (cmd: string, args: readonly string[], options?: unknown) => {
			calls.push([cmd, args, options])
			return { code: 0, stderr: "", stdout: "" }
		}
		const kit = {
			bin: "/k/bin.cjs",
			manifest: "/k/package.json",
			peer: "drizzle-kit" as const,
			runtime: process.execPath,
		}
		await runPeer(fake, kit)(["export"], { cwd: "/w" })
		expect(calls).toEqual([[process.execPath, ["/k/bin.cjs", "export"], { cwd: "/w", peer: "drizzle-kit" }]])
	})
})

describe("runPeer on comb's own Bun", () => {
	/*
	 * D2-4 of the area D round-two review: in a Bun single-file executable, process.execPath is the
	 * app, which runs its own entry unless BUN_BE_BUN is set, so drizzle-kit would respawn the app
	 */
	it("runs a peer on comb's own Bun as bun, and leaves node and a peer on another runtime as they are", async () => {
		const calls: unknown[] = []
		const fake = async (cmd: string, args: readonly string[], options?: unknown) => {
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
		/* each spawn is read as runPeer is called, so all start while onBun holds the version */
		await onBun("1.3.0", () =>
			Promise.all([
				runPeer(fake, kit)(["export"], { cwd: "/w", env: { A: "a" } }),
				runPeer(fake, kit)(["export"], { exactEnv: { A: "a" } }),
				runPeer(fake, wrangler)(["d1"]),
			]),
		)
		await onBun(undefined, () => runPeer(fake, kit)(["export"]))
		expect(calls).toEqual([
			{ cwd: "/w", env: { A: "a", BUN_BE_BUN: "1" }, peer: "drizzle-kit" },
			{ exactEnv: { A: "a", BUN_BE_BUN: "1" }, peer: "drizzle-kit" },
			{ peer: "wrangler" },
			{ peer: "drizzle-kit" },
		])
	})
})

describe("run: Atlas missing (KC6 + PA22 of r22; sibling: a bin peer's runtime)", () => {
	it("names Atlas's range and its install page when atlas cannot start, and no hint for another command", async () => {
		expect(await run("atlas", ["migrate", "hash"], { env: { PATH: "/nonexistent" } })).toEqual({
			code: 127,
			stderr: `atlas: command not found; install atlas (${ATLAS_RANGE}) from https://atlasgo.io/getting-started`,
			stdout: "",
		})
		expect((await run("comb-no-such-command", [], {})).stderr).toBe("comb-no-such-command: command not found")
	})
})

/* PA4 of r22: one asynchronous run, so a signal reaches comb while a child runs, and each RunOptions behavior as before */
describe("run, asynchronous (PA4 of r22)", () => {
	it("returns a promise, so two children run at once: one waits for a file the other writes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-run-"))
		try {
			const flag = join(dir, "flag")
			const waits = `const t = Date.now(); const f = () => require('fs').existsSync(${JSON.stringify(flag)}) ? process.exit(0) : Date.now() - t > 10000 ? process.exit(1) : setTimeout(f, 10); f()`
			const waiting = run("node", ["-e", waits])
			expect(waiting).toBeInstanceOf(Promise)
			const [waited, wrote] = await Promise.all([
				waiting,
				run("node", ["-e", `require('fs').writeFileSync(${JSON.stringify(flag)}, '')`]),
			])
			expect([waited.code, wrote.code]).toEqual([0, 0])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("feeds input to a child that never reads it, and reports how the child ended", async () => {
		const result = await run("node", ["-e", "process.exit(4)"], { input: "x".repeat(4 * 1024 * 1024) })
		expect(result).toEqual({ code: 4, stderr: "", stdout: "" })
	})

	it("leaves a lifeline's stdin open and unwritten while comb runs, where any other run's ends at once (KC5 of r22b)", async () => {
		const script =
			"process.stdin.on('end', () => process.exit(3)); process.stdin.resume(); setTimeout(() => process.exit(0), 300)"
		const [held, ended] = await Promise.all([
			run("node", ["-e", script], { lifeline: true }),
			run("node", ["-e", script]),
		])
		expect([held.code, ended.code]).toEqual([0, 3])
	})

	it("holds stderr to maxBuffer too", async () => {
		const result = await run("node", ["-e", "process.stderr.write('x'.repeat(1025))"], { maxBuffer: 1024 })
		expect(result).toEqual({ code: 1, stderr: "node: output exceeded 1024 bytes", stdout: "" })
	})

	it("reads a character whose bytes come in two writes as one", async () => {
		const script =
			"process.stdout.write(Buffer.from([0xc5])); setTimeout(() => process.stdout.write(Buffer.from([0xbe])), 50)"
		expect((await run("node", ["-e", script])).stdout).toBe("\u017e")
	})
})

/** A child that writes `ready` once it listens, then waits; on a signal it writes which to `got` and ends by it */
const SIGNALLED = (ready: string, got: string) =>
	`for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { require('fs').writeFileSync(${JSON.stringify(got)}, s); process.kill(process.pid, 'SIGKILL') }); ${recordWhole(ready, "String(process.pid)")}; setInterval(() => {}, 1000)`

describe("run under a signal (PA4 of r22)", () => {
	const kill = stubKill()
	let dir = ""
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "comb-run-signal-"))
	})
	afterEach(() => rmSync(dir, { force: true, recursive: true }))

	it.each([["SIGINT"], ["SIGTERM"]] as const)(
		"on %s passes the signal to the child, waits for its end, and only then ends comb, its caller never resumed",
		async (signal) => {
			const [ready, got] = [join(dir, "ready"), join(dir, "got")]
			let resumed = false
			void run("node", ["-e", SIGNALLED(ready, got)]).then(() => {
				resumed = true
			})
			await until(() => existsSync(ready), "the child listening")
			const child = running(Number(readFileSync(ready, "utf8")), process.pid)
			await deliver(signal)
			await until(() => kill.calls().length > 0, "comb's end")
			expect([readFileSync(got, "utf8"), runs(child), kill.calls(), resumed]).toEqual([
				signal,
				false,
				[[process.pid, signal]],
				false,
			])
		},
	)

	it("starts no child while a stop runs, outside its steps", async () => {
		const [ready, got] = [join(dir, "ready"), join(dir, "got")]
		void run("node", ["-e", SIGNALLED(ready, got)])
		await until(() => existsSync(ready), "the child listening")
		await deliver("SIGTERM")
		const late = join(dir, "late")
		void run("node", ["-e", `require('fs').writeFileSync(${JSON.stringify(late)}, '')`])
		await until(() => kill.calls().length > 0, "comb's end")
		await new Promise((resolve) => setTimeout(resolve, 200))
		expect(existsSync(late)).toBe(false)
	})
})

/* D5-4 of the area D round-five review: a stop named the runtime's path, not the peer the user ran */
describe("run, stopping a peer, names the peer", () => {
	it("names it when comb kills it past killAfterMs, after its output passed maxBuffer", async () => {
		const traps = "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(2048)); setInterval(() => {}, 1000)"
		const result = await run("node", ["-e", traps], { killAfterMs: 50, maxBuffer: 1024, peer: "drizzle-kit" })
		expect(result).toEqual({
			code: 1,
			stderr:
				"drizzle-kit: output exceeded 1024 bytes; drizzle-kit did not end 50 ms after SIGTERM: comb killed it with SIGKILL",
			stdout: "",
		})
	})

	it("names it past timeoutMs, and when a signal stopped it before it said anything", async () => {
		const waits = await run("node", ["-e", "setInterval(() => {}, 1000)"], { peer: "wrangler", timeoutMs: 50 })
		expect(waits.stderr).toBe("wrangler: stopped after 50 ms")
		const killed = await run("sh", ["-c", "kill -9 $$"], { peer: "wrangler" })
		expect(killed.stderr).toBe("wrangler was stopped by SIGKILL")
	})
})
