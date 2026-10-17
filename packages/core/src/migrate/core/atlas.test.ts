import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	checkAtlasInstalled,
	exportDrizzleSchema,
	generateIncrementalMigration,
	generateSchemaDiff,
	getAtlasVersion,
} from "./atlas.ts"
import type { Run, RunOptions, RunResult } from "./process.ts"

type Call = { cmd: string; args: readonly string[]; options: RunOptions | undefined }

/** A runner that records each call and answers from `script`, in order. */
function fakeRun(...script: Array<RunResult | ((call: Call) => RunResult)>): Run & { calls: Call[] } {
	const calls: Call[] = []
	const fake = (cmd: string, args: readonly string[], options?: RunOptions) => {
		const call = { args, cmd, options }
		calls.push(call)
		const next = script.shift()
		if (next === undefined) throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`)
		return typeof next === "function" ? next(call) : next
	}
	return Object.assign(fake, { calls })
}

const ok = (stdout = ""): RunResult => ({ code: 0, stderr: "", stdout })
const fail = (stderr: string, code = 1): RunResult => ({ code, stderr, stdout: "" })

const fileArg = (args: readonly string[], flag: string) => {
	const value = args[args.indexOf(flag) + 1] as string
	return value.replace(/^file:\/\//, "")
}

const diffWith = (result: RunResult) =>
	generateSchemaDiff({ dialect: "sqlite", fromSchema: "", run: fakeRun(result), toSchema: "" })

/** A fresh migrations directory per test, removed after it. */
function useMigrationsDir(): () => string {
	let dir = ""
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "comb-atlas-migrate-"))
	})
	afterEach(() => {
		rmSync(dir, { force: true, recursive: true })
	})
	return () => dir
}

const migrateOptions = (dir: string, run: Run) => ({
	dialect: "sqlite" as const,
	migrationName: "add_b",
	migrationsDir: dir,
	run,
	targetSchema: "T",
})

describe("atlas availability", () => {
	it("checkAtlasInstalled is true when `atlas version` exits 0", () => {
		const run = fakeRun(ok("atlas version v1.3.0"))
		expect(checkAtlasInstalled(run)).toBe(true)
		expect(run.calls.map((c) => [c.cmd, ...c.args])).toEqual([["atlas", "version"]])
	})

	it("checkAtlasInstalled is false when atlas is missing or fails", () => {
		expect(checkAtlasInstalled(fakeRun(fail("atlas: command not found", 127)))).toBe(false)
		expect(checkAtlasInstalled(fakeRun(fail("boom")))).toBe(false)
	})

	it("getAtlasVersion reads the version, or null", () => {
		expect(getAtlasVersion(fakeRun(ok("atlas version v1.3.0-6539f2704b5d\nhttps://github.com/ariga/atlas")))).toBe(
			"v1.3.0",
		)
		expect(getAtlasVersion(fakeRun(ok("no version here")))).toBeNull()
		expect(getAtlasVersion(fakeRun(fail("atlas: command not found", 127)))).toBeNull()
	})
})

describe("generateSchemaDiff", () => {
	it("diffs the two schemas through files against the dialect's dev database", () => {
		const seen: string[] = []
		const run = fakeRun((call) => {
			seen.push(readFileSync(fileArg(call.args, "--from"), "utf8"), readFileSync(fileArg(call.args, "--to"), "utf8"))
			return ok("ALTER TABLE `a` ADD COLUMN `b` text;\n")
		})
		const result = generateSchemaDiff({ dialect: "sqlite", fromSchema: "FROM", run, toSchema: "TO" })
		expect(result).toEqual({ diff: "ALTER TABLE `a` ADD COLUMN `b` text;", synced: false })
		expect(seen).toEqual(["FROM", "TO"])
		const [call] = run.calls
		expect(call?.cmd).toBe("atlas")
		expect(call?.args.slice(0, 2)).toEqual(["schema", "diff"])
		expect(call?.args.at(-1)).toBe("sqlite://file?mode=memory")
		expect(existsSync(fileArg(call?.args ?? [], "--from"))).toBe(false)
	})

	it("uses the Postgres dev database for postgres", () => {
		const run = fakeRun(ok("Schemas are synced, no changes to be made."))
		generateSchemaDiff({ dialect: "postgres", fromSchema: "", run, toSchema: "" })
		expect(run.calls[0]?.args.at(-1)).toBe("postgres://localhost:5432/dev?sslmode=disable")
	})

	it("reports synced schemas", () => {
		const synced = { diff: null, synced: true }
		expect(diffWith(ok("Schemas are synced, no changes to be made.\n"))).toEqual(synced)
		expect(diffWith(ok(""))).toEqual(synced)
		expect(diffWith(ok("-- (empty)"))).toEqual(synced)
		expect(diffWith(fail("Schemas are synced"))).toEqual(synced)
	})

	it("throws atlas's stderr when the diff fails", () => {
		const run = fakeRun(fail('Error: near "CREATE": syntax error'))
		expect(() => generateSchemaDiff({ dialect: "sqlite", fromSchema: "", run, toSchema: "x" })).toThrow(
			'Atlas diff failed: Error: near "CREATE": syntax error',
		)
	})
})

describe("generateIncrementalMigration", () => {
	const migrationsDir = useMigrationsDir()
	const options = (run: Run) => migrateOptions(migrationsDir(), run)

	it("hashes a directory without atlas.sum, then writes the new migration with the SQLite transforms", () => {
		const dir = migrationsDir()
		const run = fakeRun(ok(), (call) => {
			expect(readFileSync(fileArg(call.args, "--to"), "utf8")).toBe("T")
			writeFileSync(
				join(dir, "20261017_add_b.sql"),
				"PRAGMA foreign_keys = off;\nCREATE TABLE b (x);\nPRAGMA foreign_keys = on;\n",
			)
			return ok()
		})
		const result = generateIncrementalMigration(options(run))
		expect(result).toEqual({ files: [join(dir, "20261017_add_b.sql")], synced: false })
		expect(readFileSync(join(dir, "20261017_add_b.sql"), "utf8")).toBe(
			"PRAGMA defer_foreign_keys = on;\nCREATE TABLE b (x);\n",
		)
		expect(run.calls.map((c) => c.args.slice(0, 2))).toEqual([
			["migrate", "hash"],
			["migrate", "diff"],
		])
		expect(run.calls[1]?.args).toContain("--dev-url")
	})

	it("skips the hash when atlas.sum exists and reports synced when nothing new appears", () => {
		const dir = migrationsDir()
		writeFileSync(join(dir, "atlas.sum"), "h1:x")
		const run = fakeRun(ok("The migration directory is synced with the desired state, no changes to be made"))
		expect(generateIncrementalMigration(options(run))).toEqual({ files: [], synced: true })
		expect(run.calls).toHaveLength(1)
	})

	it("reports synced when atlas says so on stderr", () => {
		const dir = migrationsDir()
		writeFileSync(join(dir, "atlas.sum"), "h1:x")
		const run = fakeRun({ code: 0, stderr: "no changes to be made", stdout: "" })
		expect(generateIncrementalMigration(options(run))).toEqual({ files: [], synced: true })
	})
})

describe("generateIncrementalMigration: failures", () => {
	const migrationsDir = useMigrationsDir()
	const options = (run: Run) => migrateOptions(migrationsDir(), run)

	it("throws when the hash or the diff fails", () => {
		const dir = migrationsDir()
		expect(() => generateIncrementalMigration(options(fakeRun(fail("hash broke"))))).toThrow(
			"atlas migrate hash failed: hash broke",
		)
		writeFileSync(join(dir, "atlas.sum"), "h1:x")
		expect(() => generateIncrementalMigration(options(fakeRun(fail("diff broke"))))).toThrow(
			"atlas migrate diff failed: diff broke",
		)
		expect(() => generateIncrementalMigration(options(fakeRun({ code: 1, stderr: "", stdout: "out" })))).toThrow(
			"atlas migrate diff failed: out",
		)
	})
})

describe("exportDrizzleSchema", () => {
	it("runs drizzle-kit export in cwd and strips PRAGMAs and boolean defaults for SQLite", () => {
		const run = fakeRun(
			ok("PRAGMA foreign_keys=OFF;\nCREATE TABLE t (a integer DEFAULT true, b integer DEFAULT false);"),
		)
		expect(exportDrizzleSchema({ cwd: "/work", dialect: "sqlite", run })).toBe(
			"CREATE TABLE t (a integer DEFAULT 1, b integer DEFAULT 0);",
		)
		expect(run.calls).toEqual([{ args: ["drizzle-kit", "export"], cmd: "bun", options: { cwd: "/work" } }])
	})

	it("returns Postgres output as is and throws stderr on failure", () => {
		expect(exportDrizzleSchema({ cwd: "/w", dialect: "postgres", run: fakeRun(ok("PRAGMA x;\nDEFAULT true")) })).toBe(
			"PRAGMA x;\nDEFAULT true",
		)
		expect(() => exportDrizzleSchema({ cwd: "/w", dialect: "sqlite", run: fakeRun(fail("no config")) })).toThrow(
			"drizzle-kit export failed: no config",
		)
	})
})
