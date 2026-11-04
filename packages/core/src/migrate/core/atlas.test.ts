import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { checkAtlasInstalled, exportDrizzleSchema, exportWith, generateSchemaDiff, getAtlasVersion } from "./atlas.ts"
import { onBun } from "../../../tests/support/runtime.ts"
import { OPTIONAL_PEER_RANGES } from "./optional-peer.ts"

/** A drizzle-kit as a command resolves it, for a fake runner */
const KIT = {
	bin: "/kit/bin.cjs",
	manifest: "/kit/package.json",
	peer: "drizzle-kit",
	runtime: process.execPath,
} as const
import type { Run, RunOptions, RunResult } from "./process.ts"

type Call = { cmd: string; args: readonly string[]; options: RunOptions | undefined }

/** A runner that records each call and answers from `script`, in order. */
function fakeRun(...script: Array<RunResult | ((call: Call) => RunResult)>): Run & { calls: Call[] } {
	const calls: Call[] = []
	const fake = async (cmd: string, args: readonly string[], options?: RunOptions) => {
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
	it("checkAtlasInstalled is true when `atlas version` exits 0", async () => {
		const run = fakeRun(ok("atlas version v1.3.0"))
		expect(await checkAtlasInstalled(run)).toBe(true)
		expect(run.calls.map((c) => [c.cmd, ...c.args])).toEqual([["atlas", "version"]])
	})

	it("checkAtlasInstalled is false when atlas is missing or fails", async () => {
		expect(await checkAtlasInstalled(fakeRun(fail("atlas: command not found", 127)))).toBe(false)
		expect(await checkAtlasInstalled(fakeRun(fail("boom")))).toBe(false)
	})

	it("getAtlasVersion reads the version, or null", async () => {
		expect(
			await getAtlasVersion(fakeRun(ok("atlas version v1.3.0-6539f2704b5d\nhttps://github.com/ariga/atlas"))),
		).toBe("v1.3.0")
		expect(await getAtlasVersion(fakeRun(ok("no version here")))).toBeNull()
		expect(await getAtlasVersion(fakeRun(fail("atlas: command not found", 127)))).toBeNull()
	})
})

describe("generateSchemaDiff", () => {
	it("diffs the two schemas through files against the dialect's dev database", async () => {
		const seen: string[] = []
		const run = fakeRun((call) => {
			seen.push(readFileSync(fileArg(call.args, "--from"), "utf8"), readFileSync(fileArg(call.args, "--to"), "utf8"))
			return ok("ALTER TABLE `a` ADD COLUMN `b` text;\n")
		})
		const result = await generateSchemaDiff({ dialect: "sqlite", fromSchema: "FROM", run, toSchema: "TO" })
		expect(result).toEqual({ diff: "ALTER TABLE `a` ADD COLUMN `b` text;", notices: [], synced: false })
		expect(seen).toEqual(["FROM", "TO"])
		const [call] = run.calls
		expect(call?.cmd).toBe("atlas")
		expect(call?.args.slice(0, 2)).toEqual(["schema", "diff"])
		expect(call?.args.at(-1)).toMatch(/^sqlite:\/\/comb-[0-9a-f-]{36}\?mode=memory$/)
		expect(existsSync(fileArg(call?.args ?? [], "--from"))).toBe(false)
	})

	it("reports synced schemas", async () => {
		const synced = { diff: null, notices: [], synced: true }
		expect(await diffWith(ok("Schemas are synced, no changes to be made.\n"))).toEqual(synced)
	})

	/* plan 14's 5.4: Atlas OSS may say on stderr, as it succeeds, that it left part of a schema out */
	it("returns what Atlas said as it succeeded, a line each", async () => {
		const said = {
			code: 0,
			stderr: "Skipped triggers.\n\n  Atlas Pro includes them.\n",
			stdout: "Schemas are synced, no changes to be made.\n",
		}
		expect((await diffWith(said)).notices).toEqual(["Skipped triggers.", "Atlas Pro includes them."])
	})

	it("throws atlas's stderr when the diff fails", async () => {
		const run = fakeRun(fail('Error: near "CREATE": syntax error\n'))
		await expect(generateSchemaDiff({ dialect: "sqlite", fromSchema: "", run, toSchema: "x" })).rejects.toThrow(
			new Error('Atlas diff failed: Error: near "CREATE": syntax error'),
		)
	})
})

/* r18 P8: the exported diff readies the dev schema first, as migrate diff does, and explains a failure */
describe("generateSchemaDiff on Postgres", () => {
	it("diffs Postgres in the target's scoped dev database, made ready first, passed in the environment", async () => {
		const run = fakeRun(ok("Schemas are synced, no changes to be made."))
		const target = { devUrl: "postgres://localhost/dev", lockTimeout: "5s", schema: "app", url: "" }
		const readied: unknown[] = []
		const readyDev = async (each: unknown) => void readied.push(each)
		await generateSchemaDiff({ dialect: "postgres", fromSchema: "", readyDev, run, target, toSchema: "" })
		expect(readied).toEqual([target])
		expect(run.calls[0]?.args).toContain("--config")
		expect(run.calls[0]?.options?.env).toEqual({ COMB_ATLAS_DEV_URL: "postgres://localhost/dev?search_path=app" })
		await expect(generateSchemaDiff({ dialect: "postgres", fromSchema: "", run, toSchema: "" })).rejects.toThrow(
			"a Postgres diff needs a target (devUrl and schema)",
		)
	})

	it("explains a Postgres dev database that is not empty, as migrate diff does", async () => {
		const run = fakeRun(
			fail(
				'Error: sql/sqlimport: taking database snapshot: connected database is not clean: found table "leftover" in connected schema',
			),
		)
		const target = { devUrl: "postgres://localhost/dev", lockTimeout: "5s", schema: "app", url: "" }
		const diffed = generateSchemaDiff({
			dialect: "postgres",
			fromSchema: "",
			readyDev: async () => undefined,
			run,
			target,
			toSchema: "",
		})
		await expect(diffed).rejects.toThrow(
			/^Atlas diff failed: devUrl must be an empty database, and it holds table "leftover"/,
		)
	})
})

describe("exportDrizzleSchema", () => {
	it("runs drizzle-kit export in cwd and strips PRAGMAs and boolean defaults for SQLite", async () => {
		const run = fakeRun(
			ok("PRAGMA foreign_keys=OFF;\nCREATE TABLE t (a integer DEFAULT true, b integer DEFAULT false);"),
		)
		expect(await exportWith(KIT, { cwd: "/work", dialect: "sqlite", run })).toBe(
			"CREATE TABLE t (a integer DEFAULT 1, b integer DEFAULT 0);",
		)
		expect(run.calls).toEqual([
			{ args: ["/kit/bin.cjs", "export"], cmd: process.execPath, options: { cwd: "/work", peer: "drizzle-kit" } },
		])
	})

	/* K1 of r22: the drizzle-kit the project at cwd holds, its bin as its package.json names it, on the runtime running comb (AD5) */
	it("runs the drizzle-kit the project at cwd holds, and refuses a cwd that holds none", async () => {
		const run = fakeRun(ok("CREATE TABLE t (a integer);"))
		expect(await exportDrizzleSchema({ cwd: import.meta.dirname, dialect: "sqlite", run })).toBe(
			"CREATE TABLE t (a integer);",
		)
		expect(run.calls[0]?.cmd).toBe(process.execPath)
		expect(run.calls[0]?.args[0]).toMatch(/\/drizzle-kit\/bin\.cjs$/)
		await expect(exportDrizzleSchema({ cwd: tmpdir(), dialect: "sqlite", run })).rejects.toThrow(
			`comb needs drizzle-kit (${OPTIONAL_PEER_RANGES["drizzle-kit"]}) to export the drizzle schema for comb migrate diff`,
		)
	})

	it("gives each SQLite primary key column drizzle-kit leaves nullable its NOT NULL", async () => {
		const run = fakeRun(ok("CREATE TABLE `a` (\n\t`id` text PRIMARY KEY\n);\n"))
		expect(await exportWith(KIT, { cwd: "/w", dialect: "sqlite", run })).toBe(
			"CREATE TABLE `a` (\n\t`id` text NOT NULL PRIMARY KEY\n);\n",
		)
	})

	it("returns Postgres output as is and throws stderr on failure", async () => {
		expect(await exportWith(KIT, { cwd: "/w", dialect: "postgres", run: fakeRun(ok("PRAGMA x;\nDEFAULT true")) })).toBe(
			"PRAGMA x;\nDEFAULT true",
		)
		await expect(exportWith(KIT, { cwd: "/w", dialect: "sqlite", run: fakeRun(fail("no config\n")) })).rejects.toThrow(
			new Error("drizzle-kit export failed: no config"),
		)
	})
})

describe("exportDrizzleSchema's drizzle config", () => {
	/* D2-14 of the area D round-two review: drizzle-kit runs on comb's runtime, and on Node it cannot load a JSON config */
	it("refuses a JSON drizzle config when comb runs on Node, before drizzle-kit runs, and exports it on Bun", async () => {
		const run = fakeRun(ok("CREATE TABLE t (a integer);"))
		const options = { configPath: "/w/drizzle.config.json", cwd: import.meta.dirname, dialect: "sqlite" as const, run }
		await onBun(undefined, () =>
			expect(exportDrizzleSchema(options)).rejects.toThrow(
				new Error(
					"/w/drizzle.config.json is JSON, which drizzle-kit cannot load when comb runs on Node: write it as drizzle.config.ts, export default the same object, or run comb on Bun",
				),
			),
		)
		expect(run.calls).toEqual([])
		expect(await onBun("1.3.0", () => exportDrizzleSchema(options))).toBe("CREATE TABLE t (a integer);")
		expect(run.calls[0]?.args.slice(1)).toEqual(["export", "--config", "/w/drizzle.config.json"])
	})

	/* D3-2 of the area D round-three review: with no configPath, drizzle-kit looks up drizzle.config.ts, .js, then .json in cwd */
	it("refuses the JSON config drizzle-kit's own lookup finds when comb runs on Node, and exports it on Bun", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "comb-dk-lookup-"))
		try {
			writeFileSync(join(cwd, "drizzle.config.json"), "{}")
			const run = fakeRun(ok("CREATE TABLE t (a integer);"), ok("CREATE TABLE t (a integer);"))
			const options = { cwd, dialect: "sqlite" as const, run }
			await onBun(undefined, () =>
				expect(exportWith(KIT, options)).rejects.toThrow(
					new Error(
						`${join(cwd, "drizzle.config.json")} is JSON, which drizzle-kit cannot load when comb runs on Node: write it as drizzle.config.ts, export default the same object, or run comb on Bun`,
					),
				),
			)
			expect(run.calls).toEqual([])
			expect(await onBun("1.3.0", () => exportWith(KIT, options))).toBe("CREATE TABLE t (a integer);")
			expect(run.calls[0]?.args.slice(1)).toEqual(["export"])
			/* a drizzle.config.ts beside it is the one drizzle-kit loads */
			writeFileSync(join(cwd, "drizzle.config.ts"), "export default {}")
			expect(await onBun(undefined, () => exportWith(KIT, options))).toBe("CREATE TABLE t (a integer);")
		} finally {
			rmSync(cwd, { force: true, recursive: true })
		}
	})
})

/** drizzle-kit's Postgres export of `stdout`, scoped to `schema` */
const pg = (stdout: string, schema?: string) =>
	exportWith(KIT, { cwd: "/w", dialect: "postgres", run: fakeRun(ok(stdout)), schema })

describe("exportDrizzleSchema on Postgres", () => {
	it("passes the database's drizzle config to drizzle-kit", async () => {
		const run = fakeRun(ok(""))
		await exportWith(KIT, { configPath: "/w/drizzle.pg.ts", cwd: "/w", dialect: "postgres", run })
		expect(run.calls[0]?.args).toEqual(["/kit/bin.cjs", "export", "--config", "/w/drizzle.pg.ts"])
	})

	it("drops the CREATE SCHEMA of the schema comb migrates, which Atlas's scoped run already has", async () => {
		expect(await pg('CREATE SCHEMA "app";\nCREATE TABLE "app"."post" ("id" integer);\n', "app")).toBe(
			'CREATE TABLE "app"."post" ("id" integer);\n',
		)
	})

	it("refuses an object in another schema, naming it", async () => {
		await expect(pg('CREATE SCHEMA "auth";\nCREATE TABLE "auth"."users" ("id" integer);\n')).rejects.toThrow(
			'the drizzle schema creates objects outside schema "public" (CREATE SCHEMA "auth"); comb migrates one schema per database',
		)
		await expect(pg('CREATE SEQUENCE "public"."counter" START WITH 1;\n', "app")).rejects.toThrow(
			'outside schema "app" (CREATE SEQUENCE "public"."counter" START WITH 1)',
		)
		expect(
			await pg('CREATE SEQUENCE "public"."counter" START WITH 1;\nCREATE TABLE "post" ("id" integer);\n'),
		).toContain("counter")
		await expect(pg('CREATE TABLE "post" ("u" uuid REFERENCES "auth"."users"("id"));\n')).rejects.toThrow(
			'outside schema "public"',
		)
		const view = `CREATE VIEW "published" AS (select "id" from "post" where "post"."status" = 'published');\n`
		expect(await pg(view)).toBe(view)
	})
})
