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

/** A runner that answers `code` and `stderr`, and writes `result` to the result file the child is given */
function fakeRun(code: number, result?: unknown, stderr = ""): Run & { calls: Array<[string, string[], RunOptions]> } {
	const calls: Array<[string, string[], RunOptions]> = []
	const run = ((cmd: string, args: readonly string[], options: RunOptions = {}) => {
		calls.push([cmd, [...args], options])
		if (result !== undefined) fs.writeFileSync(args.at(-1) as string, JSON.stringify(result))
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
		const run = fakeRun(0, { snapshot: { tables: [] } })
		expect(loadSnapshot(tables(), { run, runtime: "bun" })).toEqual({ tables: [] })
		const [cmd, , options] = run.calls[0] as [string, string[], RunOptions]
		expect(cmd).toBe(process.execPath)
		expect(Object.keys(options.exactEnv ?? {}).sort()).toEqual(["HOME", "NODE_OPTIONS", "PATH"])
		expect(options).toMatchObject({ cwd: dir, timeoutMs: LOAD_TIMEOUT_MS })
		expect(LOAD_TIMEOUT_MS).toBe(60_000)
	})

	it("leaves out a variable the parent does not have", () => {
		vi.stubEnv("NODE_OPTIONS", undefined)
		const run = fakeRun(0, { snapshot: { tables: [] } })
		loadSnapshot(tables(), { run, runtime: "node" })
		expect(Object.keys(run.calls[0]?.[2].exactEnv ?? {})).not.toContain("NODE_OPTIONS")
	})

	it("names the file for a load past the timeout, an error the child reports, and a child that wrote nothing", () => {
		expect(() => loadSnapshot(tables(), { run: fakeRun(124) })).toThrow(`comb could not load ${tables()} within 60 s`)
		expect(() => loadSnapshot(tables(), { run: fakeRun(0, { error: "t.x: bad" }) })).toThrow(
			`comb could not load ${tables()}: t.x: bad`,
		)
		expect(() => loadSnapshot(tables(), { run: fakeRun(1, undefined, "boom\n") })).toThrow(
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
			scratch.push(path.dirname(args.at(-1) as string))
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
			const run = fakeRun(0, { snapshot: { tables: [] } })
			loadSnapshot(path.join(dir, "db.core.tables.ts"), { run })
			expect(run.calls[0]?.[1].slice(0, 2)).toEqual(["--no-env-file", "-e"])
		} finally {
			Reflect.deleteProperty(process.versions, "bun")
		}
	})
})
