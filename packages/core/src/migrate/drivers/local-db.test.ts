import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SCOPED_PRAGMAS } from "../__fixtures__/pragma-scope.ts"
import { openedWhileStopping } from "../../../tests/support/signals.ts"

vi.mock("./bun-sqlite.ts", () => ({ bunLocal: vi.fn(async () => () => ({ bun: true })) }))

const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun")
afterEach(() => {
	if (bunVersion === undefined) Reflect.deleteProperty(process.versions, "bun")
	else Object.defineProperty(process.versions, "bun", bunVersion)
	vi.restoreAllMocks()
})

/* r22b: a scratch or database opened past a stop would outlive the cleanup that ends the run */
describe("openMemory and openScratch while a signal's stop runs", () => {
	it.each(["memory", "runtime", "libsql"] as const)("open nothing on %s until it is past", async (kind) => {
		const { openMemory, openScratch } = await import("./local-db.ts")
		const { early, value } = await openedWhileStopping(() => (kind === "memory" ? openMemory() : openScratch(kind)))
		value.close()
		expect(early).toBe(false)
	})
})

describe("openMemory", () => {
	it("opens node:sqlite under Node: statements, rows and parameters", async () => {
		const { openMemory } = await import("./local-db.ts")
		const db = await openMemory()
		db.exec("CREATE TABLE t (a TEXT); CREATE TABLE u (b TEXT)")
		db.run("INSERT INTO t VALUES (?)", ["007"])
		db.run("INSERT INTO t VALUES ('x')")
		expect(db.all("SELECT a, typeof(a) AS t FROM t WHERE a = ?", ["007"])).toEqual([{ a: "007", t: "text" }])
		expect(db.all("SELECT count(*) AS n FROM t")).toEqual([{ n: 2 }])
		db.close()
	})

	it("opens bun:sqlite's under Bun", async () => {
		Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.3.11" })
		const { openMemory } = await import("./local-db.ts")
		expect(await openMemory()).toEqual({ bun: true })
	})
})

/* S1 of r21: each migration file runs on a fresh connection, so the proof's copy is a file it reopens */
describe("openScratch", () => {
	it("keeps what a connection wrote across a reopen, and none of what it set (siblings: every connection pragma a file can set)", async () => {
		const { openScratch } = await import("./local-db.ts")
		const db = await openScratch()
		db.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('kept')")
		const unset = SCOPED_PRAGMAS.map(({ read }) => db.all(read)[0])
		for (const { name, set } of SCOPED_PRAGMAS) db.exec(`PRAGMA ${name} = ${set}`)
		expect(SCOPED_PRAGMAS.map(({ read }) => db.all(read)[0])).not.toEqual(unset)
		db.reopen()
		expect(db.all("SELECT a FROM t")).toEqual([{ a: "kept" }])
		expect(SCOPED_PRAGMAS.map(({ read }) => db.all(read)[0])).toEqual(unset)
		db.close()
	})

	it("holds its file in a directory only this user can open, and removes it on close", async () => {
		const { openScratch } = await import("./local-db.ts")
		/* the directory it made, read from the call: other suites open and remove scratches alongside */
		const mkdtemp = vi.spyOn(fs, "mkdtempSync")
		const db = await openScratch()
		const dir = mkdtemp.mock.results[0]?.value as string
		expect(path.basename(dir)).toMatch(new RegExp(`^comb-scratch-${process.pid}-[0-9a-f]{8}-`))
		expect(path.dirname(dir)).toBe(os.tmpdir())
		expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
		expect(fs.readdirSync(dir)).toEqual(["copy.db"])
		db.run("CREATE TABLE t (a)")
		db.close()
		expect(fs.existsSync(dir)).toBe(false)
	})

	it("runs on libsql's engine for a libsql target, keeping what it wrote across a reopen, and names each engine (SL3 of r22)", async () => {
		const { openScratch } = await import("./local-db.ts")
		const mkdtemp = vi.spyOn(fs, "mkdtempSync")
		const libsql = await openScratch("libsql")
		/* in memory, so no connection the proof reopens holds a descriptor libsql keeps past its close */
		expect(mkdtemp).not.toHaveBeenCalled()
		expect(libsql.engine).toMatch(/^libsql's SQLite 3\.\d+\.\d+$/)
		libsql.exec(
			"CREATE TABLE t (id INTEGER PRIMARY KEY, emb F32_BLOB(3)); CREATE INDEX t_emb ON t (libsql_vector_idx(emb))",
		)
		libsql.exec("PRAGMA recursive_triggers = ON; CREATE TEMP TABLE tmp (x)")
		libsql.reopen()
		expect(libsql.all("SELECT name FROM sqlite_master WHERE name = 't_emb'")).toEqual([{ name: "t_emb" }])
		expect(libsql.all("PRAGMA recursive_triggers")).toEqual([{ recursive_triggers: 0 }])
		expect(libsql.all("SELECT name FROM temp.sqlite_master")).toEqual([])
		libsql.close()
		const runtime = await openScratch()
		expect(runtime.engine).toMatch(/^SQLite 3\.\d+\.\d+$/)
		runtime.close()
	})
})

/* S2 of r22: a scratch is named for its process, so a killed run's is swept at once, not after hours */
describe("openScratch's sweep", () => {
	it("removes a leftover named for a gone process at a process's first scratch, keeps a live one's, and sweeps once", async () => {
		vi.resetModules()
		const { hostMark } = await import("../core/cleanup.ts")
		const named = (pid: number, what: string) => path.join(os.tmpdir(), `comb-scratch-${pid}-${hostMark()}-${what}`)
		/* a pid past any pid_max, so no process runs as it */
		const [gone, live] = [named(4_194_305, "gone"), named(process.pid, "live")]
		for (const dir of [gone, live]) fs.mkdirSync(dir)
		try {
			const { openScratch } = await import("./local-db.ts")
			;(await openScratch()).close()
			expect([fs.existsSync(gone), fs.existsSync(live)]).toEqual([false, true])
			/* read from the calls, not the directory: another suite's process sweeps it alongside */
			const readdir = vi.spyOn(fs, "readdirSync")
			;(await openScratch()).close()
			expect(readdir.mock.calls.filter(([dir]) => dir === os.tmpdir())).toEqual([])
		} finally {
			for (const dir of [gone, live]) fs.rmSync(dir, { force: true, recursive: true })
		}
	})
})
