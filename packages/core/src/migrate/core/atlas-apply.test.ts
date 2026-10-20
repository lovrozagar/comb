import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ParsedMigration } from "../types.ts"
import { applyWithAtlas, type ApplyOptions, baselineWithAtlas, statusWithAtlas } from "./atlas-apply.ts"
import { sqlFiles } from "./atlas-dir.ts"
import type { Run, RunResult } from "./process.ts"

const ok = (stdout = ""): RunResult => ({ code: 0, stderr: "", stdout })
const fail = (stderr: string, stdout = ""): RunResult => ({ code: 1, stderr, stdout })
const file = (name: string) => ({ Description: name.split("_")[1], Name: name, Version: name.split("_")[0] })
const revision = (version: string, more: Record<string, unknown> = {}) => ({
	applied: 1,
	error: "",
	errorStmt: "",
	hash: `${version.length}=`,
	total: 1,
	type: "applied",
	version,
	...more,
})

type Answers = { apply?: RunResult; dryRun?: RunResult; status?: RunResult }
type Fake = Run & { calls: Array<{ args: string[]; env: Readonly<Record<string, string | undefined>> | undefined }> }

/** Atlas: hash writes a sum of name lengths, status and apply answer as told */
function fakeAtlas(answers: Answers): Fake {
	const calls: Fake["calls"] = []
	const run: Run = (_cmd, args, runOptions) => {
		calls.push({ args: [...args], env: runOptions?.env })
		if (args[1] === "hash") {
			const dir = (args[args.indexOf("--dir") + 1] as string).replace("file://", "")
			writeFileSync(
				join(dir, "atlas.sum"),
				`h1:x=\n${sqlFiles(dir)
					.map((f) => `${f} h1:${f.length}=`)
					.join("\n")}\n`,
			)
			return ok()
		}
		if (args[1] === "status") return answers.status ?? ok("{}")
		return args.includes("--dry-run") ? (answers.dryRun ?? ok("{}")) : (answers.apply ?? ok("{}"))
	}
	return Object.assign(run, { calls })
}

const status = (body: Record<string, unknown>) =>
	ok(JSON.stringify({ applied: [], available: [], current: "", error: "", pending: [], status: "OK", ...body }))

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-atlas-apply-"))
	writeFileSync(join(dir, "1_a.sql"), 'CREATE TABLE "a" ("id" int);\n')
	writeFileSync(join(dir, "2_b.sql"), 'DROP TABLE "a";\n')
	const lines = ["1_a.sql h1:7=", "2_b.sql h1:7="]
	writeFileSync(join(dir, "atlas.sum"), `h1:x=\n${lines.join("\n")}\n`)
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const TARGET = {
	devUrl: "postgres://localhost/dev",
	lockTimeout: "5s",
	schema: "public",
	url: "postgres://app:S3cret@db/app?sslmode=require",
}

function options(exec: Run, more: Partial<ApplyOptions> = {}): ApplyOptions & { out: string[]; seen: string[] } {
	const out: string[] = []
	const seen: string[] = []
	return {
		approve: async (migration: ParsedMigration) => (seen.push(migration.filename), { ok: true }),
		dir,
		exec,
		out,
		print: (line: string) => out.push(line),
		seen,
		target: TARGET,
		...more,
	}
}

const PENDING = status({
	available: [file("1_a.sql"), file("2_b.sql")],
	pending: [file("1_a.sql"), file("2_b.sql")],
	status: "PENDING",
})
const APPLIED = ok(JSON.stringify({ applied: [{ Name: "1_a.sql" }, { Name: "2_b.sql" }], error: "", target: "2" }))

describe("applyWithAtlas", () => {
	it("applies a verified private copy, reading each pending file from it, with the URL only in env", async () => {
		const atlas = fakeAtlas({ apply: APPLIED, status: PENDING })
		const run = options(atlas)
		expect(await applyWithAtlas(run)).toEqual(["1_a.sql", "2_b.sql"])
		expect(run.seen).toEqual(["1_a.sql", "2_b.sql"])
		const apply = atlas.calls.find((call) => call.args[1] === "apply" && !call.args.includes("--dry-run"))
		const applyArgs = apply?.args ?? []
		const copy = (applyArgs[applyArgs.indexOf("--dir") + 1] as string).replace("file://", "")
		expect(copy).not.toBe(dir)
		expect(existsSync(copy)).toBe(false)
		expect(atlas.calls.map((call) => call.args.join(" ")).join("\n")).not.toContain("S3cret")
		expect(apply?.env?.["COMB_ATLAS_URL"]).toContain("S3cret")
		expect(run.out).toEqual(["Apply: 1_a.sql", "Apply: 2_b.sql"])
	})

	it("passes Atlas no flag that would skip comb's checks, nor an amount", async () => {
		const atlas = fakeAtlas({ apply: APPLIED, status: PENDING })
		await applyWithAtlas(options(atlas))
		const args = atlas.calls.flatMap((call) => call.args)
		for (const flag of ["--exec-order", "--allow-dirty", "--tx-mode", "--baseline", "--to-version"])
			expect(args).not.toContain(flag)
		for (const call of atlas.calls.filter((c) => c.args[1] === "apply")) {
			const bare = call.args.slice(2).filter((arg, i, all) => !arg.startsWith("--") && !all[i - 1]?.startsWith("--"))
			expect(bare).toEqual([])
		}
	})

	it("runs the dry run before anyone is asked, and stops there on a database that needs a baseline", async () => {
		const atlas = fakeAtlas({
			dryRun: fail(
				'Error: connected database is not clean: found table "x" in schema "public". baseline version or allow-dirty is required',
			),
			status: PENDING,
		})
		const run = options(atlas)
		await expect(applyWithAtlas(run)).rejects.toThrow(
			"the database has objects but no migration history; if its schema matches the migrations, record them with comb migrate baseline",
		)
		expect(run.seen).toEqual([])
	})

	it("stops when a migration is not approved, before Atlas applies anything", async () => {
		const atlas = fakeAtlas({ apply: APPLIED, status: PENDING })
		const run = options(atlas, { approve: async () => ({ message: "2_b.sql is unsafe", ok: false }) })
		await expect(applyWithAtlas(run)).rejects.toThrow("2_b.sql is unsafe")
		expect(atlas.calls.some((call) => call.args[1] === "apply" && !call.args.includes("--dry-run"))).toBe(false)
	})
})

describe("applyWithAtlas: what it classifies against", () => {
	it("classifies each pending file against the schema the files before it leave, a function they create included", async () => {
		writeFileSync(join(dir, "1_a.sql"), "CREATE FUNCTION purge() RETURNS void LANGUAGE sql AS $$ DELETE FROM a $$;\n")
		writeFileSync(join(dir, "2_b.sql"), "SELECT purge();\n")
		const safety: string[] = []
		const later = status({
			applied: [revision("1")],
			available: [file("1_a.sql"), file("2_b.sql")],
			current: "1",
			pending: [file("2_b.sql")],
			status: "PENDING",
		})
		const approve = async (migration: ParsedMigration) => (
			safety.push(migration.classification.safety),
			{ ok: true as const }
		)
		await applyWithAtlas(options(fakeAtlas({ apply: APPLIED, status: later }), { approve }))
		expect(safety).toEqual(["cautious"])
	})
})

describe("applyWithAtlas: what it prints", () => {
	it("prints each pending file's lock warnings before it applies", async () => {
		writeFileSync(join(dir, "1_a.sql"), 'CREATE INDEX "i" ON "post" ("id");\n')
		const run = options(fakeAtlas({ apply: APPLIED, status: PENDING }))
		await applyWithAtlas(run)
		expect(run.out[0]).toMatch(/^Lock warning in 1_a\.sql: CREATE INDEX "i" ON "post" \("id"\) \(blocks writes to post/)
	})

	it("does nothing when nothing is pending", async () => {
		const atlas = fakeAtlas({ status: status({ status: "OK" }) })
		const run = options(atlas)
		expect(await applyWithAtlas(run)).toEqual([])
		expect(run.out).toEqual(["No migrations to apply"])
		expect(atlas.calls.some((call) => call.args[1] === "apply")).toBe(false)
	})
})

describe("applyWithAtlas: what Atlas reports", () => {
	it("refuses a history Atlas reports an error for, such as a file added out of order", async () => {
		const late = status({
			error: "migration file 1_late.sql was added out of order. See: https://atlasgo.io",
			status: "PENDING",
		})
		await expect(applyWithAtlas(options(fakeAtlas({ status: late })))).rejects.toThrow(
			"1_late.sql is older than a migration already applied; rename it to a newer version and run atlas migrate hash",
		)
		const other = status({ error: "connect to postgres://app:S3cret@db failed" })
		await expect(applyWithAtlas(options(fakeAtlas({ status: other })))).rejects.toThrow(
			"atlas migrate status: connect to postgres://app:***@db failed",
		)
	})

	it("takes a fresh database's files as pending, not late", async () => {
		const fresh = status({
			available: [file("1_a.sql")],
			current: "No migration applied yet",
			pending: [file("1_a.sql")],
		})
		expect(await applyWithAtlas(options(fakeAtlas({ apply: APPLIED, status: fresh })))).toEqual(["1_a.sql", "2_b.sql"])
	})

	it("refuses a file older than the latest applied that Atlas skips without a word", async () => {
		const skipped = status({ applied: [revision("2")], available: [file("1_a.sql"), file("2_b.sql")], current: "2" })
		await expect(applyWithAtlas(options(fakeAtlas({ status: skipped })))).rejects.toThrow(
			"1_a.sql is older than a migration already applied; rename it to a newer version and run atlas migrate hash",
		)
	})

	it("names the file and statement that failed, and says the earlier files stay applied", async () => {
		const failed = { Error: { Stmt: 'DROP TABLE "a";', Text: "pq: table missing (42P01)" }, Name: "2_b.sql" }
		const apply = fail("x", JSON.stringify({ applied: [{ Name: "1_a.sql" }, failed], error: "boom" }))
		await expect(applyWithAtlas(options(fakeAtlas({ apply, status: PENDING })))).rejects.toThrow(
			'2_b.sql failed at DROP TABLE "a";: pq: table missing (42P01). It was rolled back; the files before it stay applied',
		)
	})
})

describe("applyWithAtlas: Atlas failing", () => {
	it("reports an apply that failed outside any one file, from its report or its stderr", async () => {
		const reported = ok(JSON.stringify({ applied: [], error: "Error: lock is held by other session" }))
		await expect(applyWithAtlas(options(fakeAtlas({ apply: reported, status: PENDING })))).rejects.toThrow(
			"atlas migrate apply: another migrate apply is running on this database",
		)
		const exited = { code: 1, stderr: "Error: killed", stdout: JSON.stringify({ applied: [], error: "" }) }
		await expect(applyWithAtlas(options(fakeAtlas({ apply: exited, status: PENDING })))).rejects.toThrow(
			"atlas migrate apply: Error: killed",
		)
	})

	it("reports a status Atlas could not take", async () => {
		await expect(applyWithAtlas(options(fakeAtlas({ status: fail("Error: no route") })))).rejects.toThrow(
			"atlas migrate status: Error: no route",
		)
	})

	it("says so when Atlas answers with something comb cannot read, without echoing it", async () => {
		await expect(
			applyWithAtlas(options(fakeAtlas({ status: ok("postgres://app:S3cret@db not json") }))),
		).rejects.toThrow("unexpected output from atlas migrate status")
		const apply = fail("Error: dial postgres://app:S3cret@db: connection refused")
		await expect(applyWithAtlas(options(fakeAtlas({ apply, status: PENDING })))).rejects.toThrow(
			"atlas migrate apply: Error: dial postgres://app:***@db: connection refused",
		)
	})
})

/** Atlas's status when 2_b.sql ran 2 of 3 statements outside a transaction, its revision recording `hash` */
const partial = (hash: string) =>
	status({
		applied: [
			revision("2", { applied: 2, error: "pq: relation missing", errorStmt: 'ALTER TABLE "nope"', hash, total: 3 }),
		],
		error: "pq: relation missing",
		pending: [file("2_b.sql")],
		status: "PENDING",
	})

describe("applyWithAtlas: a file Atlas runs outside a transaction that failed halfway", () => {
	it("refuses to resume when the file changed since, since Atlas resumes by statement count", async () => {
		await expect(applyWithAtlas(options(fakeAtlas({ status: partial("other=") })))).rejects.toThrow(
			'2_b.sql ran 2 of its 3 statements before it failed at ALTER TABLE "nope" (pq: relation missing), outside a transaction, and has changed since; restore it, or fix the database by hand and run comb migrate baseline',
		)
	})

	it("resumes an unchanged file, saying where it stopped", async () => {
		const run = options(fakeAtlas({ apply: APPLIED, status: partial("7=") }))
		await applyWithAtlas(run)
		expect(run.out[0]).toBe(
			'2_b.sql ran 2 of its 3 statements before it failed at ALTER TABLE "nope" (pq: relation missing); resuming after them',
		)
	})
})

describe("baselineWithAtlas", () => {
	it("records every file up to the directory's latest as applied, running none", () => {
		const atlas = fakeAtlas({ status: status({ pending: [file("1_a.sql"), file("2_b.sql")] }) })
		const run = options(atlas)
		expect(baselineWithAtlas(run)).toEqual(["1_a.sql", "2_b.sql"])
		const set = atlas.calls.find((call) => call.args[1] === "set")
		expect(set?.args.slice(0, 3)).toEqual(["migrate", "set", "2"])
		expect(run.out).toEqual(["Marked applied: 1_a.sql", "Marked applied: 2_b.sql"])
	})

	it("refuses a database that already records migrations, and a directory with none", () => {
		const recorded = status({ applied: [revision("1")], current: "1" })
		expect(() => baselineWithAtlas(options(fakeAtlas({ status: recorded })))).toThrow(
			"the database already records 1 migration (up to 1); baseline marks a database that has none",
		)
		rmSync(join(dir, "1_a.sql"))
		rmSync(join(dir, "2_b.sql"))
		writeFileSync(join(dir, "atlas.sum"), "h1:x=\n\n")
		expect(() => baselineWithAtlas(options(fakeAtlas({ status: status({}) })))).toThrow(
			"there are no migrations to record",
		)
	})

	it("records a database whose status Atlas refuses as not clean, which is what baseline is for", () => {
		const notClean = fail('Error: sql/migrate: connected database is not clean: found table "post" in schema "public".')
		const atlas = fakeAtlas({ status: notClean })
		expect(baselineWithAtlas(options(atlas))).toEqual(["1_a.sql", "2_b.sql"])
		expect(atlas.calls.some((call) => call.args[1] === "set")).toBe(true)
	})

	it("says what Atlas could not set", () => {
		const atlas = fakeAtlas({ status: status({}) })
		const failing: Run = (cmd, args, more) => (args[1] === "set" ? fail("Error: boom") : atlas(cmd, args, more))
		expect(() => baselineWithAtlas(options(failing))).toThrow("atlas migrate set: Error: boom")
	})
})

describe("statusWithAtlas", () => {
	it("lists what is applied and what is pending", () => {
		const run = options(
			fakeAtlas({
				status: status({
					applied: [revision("1", { hash: "7=" })],
					current: "1",
					pending: [file("2_b.sql")],
					status: "PENDING",
				}),
			}),
		)
		statusWithAtlas(run)
		expect(run.out).toEqual(["Applied: 1 (up to 1)", "Pending: 2_b.sql"])
	})

	it("warns of an applied file that changed since, which Atlas never runs again", () => {
		const run = options(fakeAtlas({ status: status({ applied: [revision("1", { hash: "other=" })], current: "1" }) }))
		statusWithAtlas(run)
		expect(run.out).toEqual([
			"Applied: 1 (up to 1)",
			"Pending: none",
			"Changed after it was applied: 1_a.sql; Atlas will not run it again, so the database may not match it",
		])
	})

	it("names a revision whose file is gone by its version, and does not call it changed", () => {
		const run = options(fakeAtlas({ status: status({ applied: [revision("9", { hash: "x=" })], current: "9" }) }))
		statusWithAtlas(run)
		expect(run.out).toEqual(["Applied: 1 (up to 9)", "Pending: none"])
	})

	it("reports a file Atlas ran halfway, and an error in the history", () => {
		const half = status({
			applied: [revision("2", { applied: 1, error: "pq: x", errorStmt: "S", hash: "7=", total: 2 })],
			error: "pq: x",
			pending: [file("2_b.sql")],
		})
		const run = options(fakeAtlas({ status: half }))
		statusWithAtlas(run)
		expect(run.out).toContain(
			"2_b.sql ran 1 of its 2 statements before it failed at S (pq: x); migrate apply resumes after them",
		)
		expect(() => statusWithAtlas(options(fakeAtlas({ status: status({ error: "broken" }) })))).toThrow(
			"atlas migrate status: broken",
		)
	})
})
