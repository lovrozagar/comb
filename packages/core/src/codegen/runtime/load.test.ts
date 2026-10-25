import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type Run, type RunOptions, run as realRun } from "../../migrate/core/process.ts"
import { fixtureRoot } from "../__fixtures__/temp.ts"
import { childArgs, LOAD_TIMEOUT_MS, loadSnapshot } from "./load.ts"

let dir: string

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-load-"))
})

afterEach(() => {
	vi.unstubAllEnvs()
	fs.rmSync(dir, { force: true, recursive: true })
})

/** The job the supervisor is handed, its last argument */
type Job = { args: string[]; cmd: string; status: string; timeoutMs: number }
const jobOf = (args: readonly string[]): Job => JSON.parse(args.at(-1) as string) as Job

/**
 * A runner that answers `code` and `stderr`, writes `result` to the result file the child is given,
 * and, when `timedOut`, the supervisor's timeout to its status file
 */
function fakeRun(
	code: number,
	{ result, stderr = "", timedOut = false }: { result?: unknown; stderr?: string; timedOut?: boolean } = {},
): Run & { calls: Array<[string, string[], RunOptions]> } {
	const calls: Array<[string, string[], RunOptions]> = []
	const run = ((cmd: string, args: readonly string[], options: RunOptions = {}) => {
		calls.push([cmd, [...args], options])
		const job = jobOf(args)
		if (result !== undefined) fs.writeFileSync(job.args.at(-1) as string, JSON.stringify(result))
		if (timedOut) fs.writeFileSync(job.status, JSON.stringify({ timedOut: true }))
		return { code, stderr, stdout: "" }
	}) as Run & { calls: typeof calls }
	run.calls = calls
	return run
}

describe("childArgs", () => {
	it("runs child.ts alone by -e: under bun with no dotenv file, under node with the hooks and the resolve flag first", () => {
		const bun = childArgs("bun", ["t.ts", "r.json"])
		expect(bun.slice(0, 2)).toEqual(["--no-env-file", "-e"])
		expect(bun[2]).toMatch(/await import\("file:\/\/.*\/runtime\/child\.ts"\)/)
		expect(bun.slice(3)).toEqual(["t.ts", "r.json"])
		const node = childArgs("node", ["t.ts", "r.json"])
		expect(node.slice(0, 3)).toEqual([
			"--experimental-import-meta-resolve",
			"--disable-warning=ExperimentalWarning",
			"--import",
		])
		expect(node[3]).toMatch(/^data:text\/javascript,import\{install\}from"file:\/\/.*node-hooks\.mjs";install\(\)$/)
		expect(node.slice(4, 6)).toEqual(["--input-type=module", "-e"])
		expect(node.slice(-2)).toEqual(["t.ts", "r.json"])
	})
})

/** The tables file of the fixture directory */
const tables = () => path.join(dir, "db.core.tables.ts")

describe("loadSnapshot", () => {
	it("runs the child with PATH, HOME and NODE_OPTIONS only, a minute to finish, beside the tables file", () => {
		vi.stubEnv("COMB_SECRET", "parent")
		vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=512")
		const run = fakeRun(0, { result: { snapshot: { tables: [] } } })
		expect(loadSnapshot(tables(), { run, runtime: "bun" })).toEqual({ tables: [] })
		const [cmd, args, options] = run.calls[0] as [string, string[], RunOptions]
		expect(cmd).toBe(process.execPath)
		expect(Object.keys(options.exactEnv ?? {}).sort()).toEqual(["HOME", "NODE_OPTIONS", "PATH"])
		/* the child gets the minute; codegen stops the supervisor only if it outlives the child's timeout */
		expect(options).toMatchObject({ cwd: dir, timeoutMs: LOAD_TIMEOUT_MS + 10_000 })
		expect(jobOf(args)).toMatchObject({ cmd: process.execPath, timeoutMs: LOAD_TIMEOUT_MS })
		expect(LOAD_TIMEOUT_MS).toBe(60_000)
	})

	it("leaves out a variable the parent does not have", () => {
		vi.stubEnv("NODE_OPTIONS", undefined)
		const run = fakeRun(0, { result: { snapshot: { tables: [] } } })
		loadSnapshot(tables(), { run, runtime: "node" })
		expect(Object.keys(run.calls[0]?.[2].exactEnv ?? {})).not.toContain("NODE_OPTIONS")
	})

	it("names the file for a load past the timeout, an error the child reports, and a child that wrote nothing", () => {
		/* the supervisor's status file says so, whatever code it exits with; codegen's stopping it says so too */
		expect(() => loadSnapshot(tables(), { run: fakeRun(124, { timedOut: true }) })).toThrow(
			`comb timed out after 60 s loading ${tables()}`,
		)
		expect(() => loadSnapshot(tables(), { run: fakeRun(124) })).toThrow(`comb timed out after 60 s loading ${tables()}`)
		expect(() => loadSnapshot(tables(), { run: fakeRun(0, { result: { error: "t.x: bad" } }) })).toThrow(
			`comb could not load ${tables()}: t.x: bad`,
		)
		expect(() => loadSnapshot(tables(), { run: fakeRun(1, { stderr: "boom\n" }) })).toThrow(
			`comb could not load ${tables()}: boom`,
		)
		expect(() => loadSnapshot(tables(), { run: fakeRun(139) })).toThrow(
			`comb could not load ${tables()}: the loader exited 139`,
		)
	})

	it("loads for real in a child on the runtime the tests run on, removing its scratch directory", () => {
		fs.writeFileSync(
			tables(),
			`import { sqliteTable } from "drizzle-orm/sqlite-core"\nimport { c } from "@lovrozagar/comb/sqlite/columns"\nexport const note = sqliteTable("note", { id: c.id("not") })\n`,
		)
		const scratch: string[] = []
		const run: Run = (cmd, args, options) => {
			scratch.push(path.dirname(jobOf(args).status))
			return realRun(cmd, args, options)
		}
		expect(loadSnapshot(tables(), { run }).tables.map((table) => table.exportName)).toEqual(["note"])
		expect(scratch[0]?.startsWith(path.join(os.tmpdir(), "comb-codegen-"))).toBe(true)
		expect(fs.existsSync(scratch[0] as string)).toBe(false)
	})
})

describe("loadSnapshot on bun", () => {
	it("runs the child the bun way when codegen runs on bun", () => {
		Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.3" })
		try {
			const run = fakeRun(0, { result: { snapshot: { tables: [] } } })
			loadSnapshot(path.join(dir, "db.core.tables.ts"), { run })
			const args = run.calls[0]?.[1] as string[]
			expect(args.slice(0, 2)).toEqual(["--no-env-file", "-e"])
			expect(jobOf(args).args.slice(0, 2)).toEqual(["--no-env-file", "-e"])
		} finally {
			Reflect.deleteProperty(process.versions, "bun")
		}
	})
})

/* F42 of the 0.13.0 round: a module that keeps a timer or a pool open must not keep the child alive
   once the snapshot is written, so the parent reads it at once instead of waiting out the timeout */
describe("loadSnapshot on a module that holds the event loop open", () => {
	it("reads the snapshot without waiting for the module's timer", () => {
		fs.writeFileSync(tables(), "setInterval(() => {}, 1000)\nexport {}\n")
		const started = Date.now()
		expect(loadSnapshot(tables(), { run: realRun, timeoutMs: 8000 })).toEqual({ tables: [] })
		expect(Date.now() - started).toBeLessThan(8000)
	})
})

/** Whether a process of `pid` still runs */
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/** The stuck module in the fixture directory, recording its pids to `pids.json` beside it */
function stuckTables(): string {
	fs.writeFileSync(
		tables(),
		`import { spawn } from "node:child_process"\nimport fs from "node:fs"\nprocess.on("SIGTERM", () => {})\nconst grandchild = spawn("sleep", ["600"], { stdio: "ignore" })\nfs.writeFileSync(${JSON.stringify(path.join(dir, "pids.json"))}, JSON.stringify({ grandchild: grandchild.pid, loader: process.pid }))\nfor (;;) {}\n`,
	)
	return tables()
}

/** The pids the module recorded, once it has */
async function pidsOf(): Promise<{ grandchild: number; loader: number }> {
	const file = path.join(dir, "pids.json")
	for (let tries = 0; tries < 200 && !fs.existsSync(file); tries++) await new Promise((r) => setTimeout(r, 50))
	return JSON.parse(fs.readFileSync(file, "utf8")) as { grandchild: number; loader: number }
}

/*
 * F43 of the 0.13.0 round: a module that ignores SIGTERM, starts a sleeping grandchild and spins in
 * a synchronous loop. The timeout kills the loader's whole group, and so does a Ctrl-C, which reaches
 * codegen and its supervisor but never the loader's own group.
 */
describe("loadSnapshot on a module stuck in a synchronous loop, with a process of its own", () => {
	it("times out, naming the file and the time, and leaves neither the loader nor its grandchild", async () => {
		expect(() => loadSnapshot(stuckTables(), { run: realRun, timeoutMs: 3000 })).toThrow(
			`comb timed out after 3 s loading ${tables()}`,
		)
		const { grandchild, loader } = await pidsOf()
		await new Promise((r) => setTimeout(r, 200))
		expect([alive(loader), alive(grandchild)]).toEqual([false, false])
	})

	it("leaves nothing when codegen is Ctrl-C'd while the module loads", async () => {
		const script = path.join(dir, "codegen.ts")
		fs.writeFileSync(
			script,
			`import { loadSnapshot } from ${JSON.stringify(new URL("./load.ts", import.meta.url).pathname)}\nloadSnapshot(${JSON.stringify(stuckTables())})\n`,
		)
		/* a terminal's Ctrl-C signals the foreground group: codegen and its supervisor */
		const codegen = spawn("bun", [script], { detached: true, stdio: "ignore" })
		const { grandchild, loader } = await pidsOf()
		process.kill(-(codegen.pid as number), "SIGINT")
		await new Promise((r) => setTimeout(r, 1500))
		expect([alive(codegen.pid as number), alive(loader), alive(grandchild)]).toEqual([false, false, false])
	})
})

/* F44 of the 0.13.0 round: a seeder the tables module imports only on demand never runs at codegen */
describe("loadSnapshot on a tables module that imports a seeder on demand", () => {
	it("loads the tables module without running the seeder", () => {
		const ran = path.join(dir, "seeded")
		fs.writeFileSync(
			path.join(dir, "seed.ts"),
			`import fs from "node:fs"\nfs.writeFileSync(${JSON.stringify(ran)}, "ran")\nexport {}\n`,
		)
		fs.writeFileSync(tables(), `export async function seed() {\n\tawait import("./seed.ts")\n}\n`)
		expect(loadSnapshot(tables(), { run: realRun })).toEqual({ tables: [] })
		expect(fs.existsSync(ran)).toBe(false)
	})
})
