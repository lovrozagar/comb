import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	checkAtlasInstalled,
	exportDrizzleSchema,
	generateMigrationFile,
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

	it("diffs Postgres in the target's scoped dev database, passed in the environment", () => {
		const run = fakeRun(ok("Schemas are synced, no changes to be made."))
		const target = { devUrl: "postgres://localhost/dev", lockTimeout: "5s", schema: "app", url: "" }
		generateSchemaDiff({ dialect: "postgres", fromSchema: "", run, target, toSchema: "" })
		expect(run.calls[0]?.args).toContain("--config")
		expect(run.calls[0]?.options?.env).toEqual({ COMB_ATLAS_DEV_URL: "postgres://localhost/dev?search_path=app" })
		expect(() => generateSchemaDiff({ dialect: "postgres", fromSchema: "", run, toSchema: "" })).toThrow(
			"a Postgres diff needs a target (devUrl and schema)",
		)
	})

	it("reports synced schemas", () => {
		const synced = { diff: null, synced: true }
		expect(diffWith(ok("Schemas are synced, no changes to be made.\n"))).toEqual(synced)
	})

	it("throws atlas's stderr when the diff fails", () => {
		const run = fakeRun(fail('Error: near "CREATE": syntax error'))
		expect(() => generateSchemaDiff({ dialect: "sqlite", fromSchema: "", run, toSchema: "x" })).toThrow(
			'Atlas diff failed: Error: near "CREATE": syntax error',
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

/** drizzle-kit's Postgres export of `stdout`, scoped to `schema` */
const pg = (stdout: string, schema?: string) =>
	exportDrizzleSchema({ cwd: "/w", dialect: "postgres", run: fakeRun(ok(stdout)), schema })

describe("exportDrizzleSchema on Postgres", () => {
	it("passes the database's drizzle config to drizzle-kit", () => {
		const run = fakeRun(ok(""))
		exportDrizzleSchema({ configPath: "/w/drizzle.pg.ts", cwd: "/w", dialect: "postgres", run })
		expect(run.calls[0]?.args).toEqual(["drizzle-kit", "export", "--config", "/w/drizzle.pg.ts"])
	})

	it("drops the CREATE SCHEMA of the schema comb migrates, which Atlas's scoped run already has", () => {
		expect(pg('CREATE SCHEMA "app";\nCREATE TABLE "app"."post" ("id" integer);\n', "app")).toBe(
			'CREATE TABLE "app"."post" ("id" integer);\n',
		)
	})

	it("refuses an object in another schema, naming it", () => {
		expect(() => pg('CREATE SCHEMA "auth";\nCREATE TABLE "auth"."users" ("id" integer);\n')).toThrow(
			'the drizzle schema creates objects outside schema "public" (CREATE SCHEMA "auth"); comb migrates one schema per database',
		)
		expect(() => pg('CREATE SEQUENCE "public"."counter" START WITH 1;\n', "app")).toThrow(
			'outside schema "app" (CREATE SEQUENCE "public"."counter" START WITH 1)',
		)
		expect(pg('CREATE SEQUENCE "public"."counter" START WITH 1;\nCREATE TABLE "post" ("id" integer);\n')).toContain(
			"counter",
		)
		expect(() => pg('CREATE TABLE "post" ("u" uuid REFERENCES "auth"."users"("id"));\n')).toThrow(
			'outside schema "public"',
		)
		const view = `CREATE VIEW "published" AS (select "id" from "post" where "post"."status" = 'published');\n`
		expect(pg(view)).toBe(view)
	})
})

describe("generateMigrationFile", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "comb-atlas-test-"))
	})

	afterEach(() => {
		rmSync(tmpDir, { force: true, recursive: true })
	})

	it("creates migration file with diff content", () => {
		const filepath = generateMigrationFile({
			diff: "CREATE TABLE users (id TEXT PRIMARY KEY);",
			migrationName: "init",
			migrationsDir: tmpDir,
		})

		expect(existsSync(filepath)).toBe(true)
		const content = readFileSync(filepath, "utf-8")
		expect(content).toContain("CREATE TABLE users")
		expect(content).toContain("Migration: init")
	})

	it("includes description when provided", () => {
		const filepath = generateMigrationFile({
			description: "Initial schema",
			diff: "CREATE TABLE users (id TEXT);",
			migrationName: "init",
			migrationsDir: tmpDir,
		})

		const content = readFileSync(filepath, "utf-8")
		expect(content).toContain("Initial schema")
	})

	it("creates migrations dir if missing", () => {
		const nestedDir = join(tmpDir, "nested", "migrations")
		const filepath = generateMigrationFile({
			diff: "SELECT 1;",
			migrationName: "test",
			migrationsDir: nestedDir,
		})

		expect(existsSync(filepath)).toBe(true)
	})

	it("generates timestamped filename", () => {
		const filepath = generateMigrationFile({
			diff: "SELECT 1;",
			migrationName: "add_users",
			migrationsDir: tmpDir,
		})

		const filename = basename(filepath)
		expect(filename).toMatch(/^\d{8}_add_users\.sql$/)
	})
})

describe("generateMigrationFile and Atlas's directives", () => {
	let dirForDirectives = ""
	beforeEach(() => {
		dirForDirectives = mkdtempSync(join(tmpdir(), "comb-migration-file-"))
	})
	afterEach(() => rmSync(dirForDirectives, { force: true, recursive: true }))

	it("keeps Atlas's directives first, a blank line after them, above its own header", () => {
		const file = generateMigrationFile({
			diff: "-- atlas:txmode none\nCREATE INDEX CONCURRENTLY i ON t (a);\n",
			migrationName: "idx",
			migrationsDir: dirForDirectives,
		})
		const text = readFileSync(file, "utf8")
		expect(text.startsWith("-- atlas:txmode none\n\n-- Migration: idx\n")).toBe(true)
		expect(text.endsWith("\nCREATE INDEX CONCURRENTLY i ON t (a);\n")).toBe(true)
	})
})
