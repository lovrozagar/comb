import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SCOPED_PRAGMAS } from "../__fixtures__/pragma-scope.ts"

vi.mock("./bun-sqlite.ts", () => ({ bunLocal: vi.fn(async () => () => ({ bun: true })) }))

const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun")
afterEach(() => {
	if (bunVersion === undefined) Reflect.deleteProperty(process.versions, "bun")
	else Object.defineProperty(process.versions, "bun", bunVersion)
	vi.restoreAllMocks()
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
		expect(path.basename(dir)).toMatch(/^comb-scratch-/)
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

describe("sweepScratch", () => {
	it("removes the scratch a killed run left, and keeps a live run's, another user's, and every other directory", async () => {
		const { SCRATCH_STALE_MS, sweepScratch } = await import("./local-db.ts")
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "comb-sweep-"))
		try {
			for (const name of ["comb-scratch-old", "comb-scratch-new", "comb-codegen-old"])
				fs.mkdirSync(path.join(root, name))
			fs.symlinkSync(path.join(root, "gone"), path.join(root, "comb-scratch-dangling"))
			const now = fs.statSync(path.join(root, "comb-scratch-new")).mtimeMs + SCRATCH_STALE_MS / 2
			const old = (now - SCRATCH_STALE_MS - 1000) / 1000
			fs.utimesSync(path.join(root, "comb-scratch-old"), old, old)
			fs.utimesSync(path.join(root, "comb-codegen-old"), old, old)
			sweepScratch(root, now)
			expect(fs.readdirSync(root).sort()).toEqual(["comb-codegen-old", "comb-scratch-dangling", "comb-scratch-new"])

			fs.mkdirSync(path.join(root, "comb-scratch-theirs"))
			fs.utimesSync(path.join(root, "comb-scratch-theirs"), old, old)
			vi.spyOn(process, "getuid").mockReturnValue(-1)
			sweepScratch(root, now)
			expect(fs.existsSync(path.join(root, "comb-scratch-theirs"))).toBe(true)
			/* a platform with no user ids sweeps by age alone */
			const getuid = Object.getOwnPropertyDescriptor(process, "getuid") as PropertyDescriptor
			Object.defineProperty(process, "getuid", { configurable: true, value: undefined })
			try {
				sweepScratch(root, now)
			} finally {
				Object.defineProperty(process, "getuid", getuid)
			}
			expect(fs.existsSync(path.join(root, "comb-scratch-theirs"))).toBe(false)
		} finally {
			fs.rmSync(root, { force: true, recursive: true })
		}
	})

	it("sweeps the system's temp directory once, when a process opens its first scratch", async () => {
		vi.resetModules()
		const stale = fs.mkdtempSync(path.join(os.tmpdir(), "comb-scratch-"))
		const old = (Date.now() - 7 * 60 * 60_000) / 1000
		fs.utimesSync(stale, old, old)
		const { openScratch } = await import("./local-db.ts")
		;(await openScratch()).close()
		expect(fs.existsSync(stale)).toBe(false)
		/* read from the calls, not the directory: another suite's process sweeps it alongside */
		const readdir = vi.spyOn(fs, "readdirSync")
		;(await openScratch()).close()
		expect(readdir.mock.calls.filter(([dir]) => dir === os.tmpdir())).toEqual([])
	})
})
