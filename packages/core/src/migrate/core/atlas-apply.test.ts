import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ParsedMigration } from "../types.ts"
import { applyWithAtlas, type ApplyOptions, baselineWithAtlas, statusWithAtlas } from "./atlas-apply.ts"
import { sumHashes } from "./atlas-dir.ts"
import { postgresParser } from "./pg-parser.ts"
import type { Run } from "./process.ts"
import { fail, type Fake, fakeAtlas, file, ok, revision, status } from "../../../tests/support/fake-atlas.ts"

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
			"the database has objects but no migration history, and no shared history row matches this directory's files (a database made by hand, or another directory's history); if its schema matches the migrations, record them with comb migrate baseline",
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

/** The Atlas commands a fake was asked to run, by their first two words */
const commands = (fake: Fake) => fake.calls.map((call) => call.args.slice(0, 2).join(" "))

describe("applyWithAtlas: a check (M11)", () => {
	it("inspects a database with no history instead of the dry run, and refuses one holding a table", async () => {
		const legacy = ok(JSON.stringify({ schemas: [{ name: "public", tables: [{ name: "legacy" }] }] }))
		const unclean = fakeAtlas({ inspect: legacy, status: PENDING })
		await expect(applyWithAtlas({ ...options(unclean), checkOnly: true })).rejects.toThrow("comb migrate baseline")
		const clean = fakeAtlas({ status: PENDING })
		expect(await applyWithAtlas({ ...options(clean), checkOnly: true })).toEqual(["1_a.sql", "2_b.sql"])
		expect(commands(clean)).not.toContain("migrate apply")
		expect(commands(clean)).toContain("schema inspect")
	})

	it("dry-runs a database with history, and inspects nothing", async () => {
		const fake = fakeAtlas({
			status: status({
				/* the hash atlas.sum records for the file, as Atlas recorded it */
				applied: [revision("1", { hash: sumHashes(dir).get("1_a.sql") })],
				available: [file("1_a.sql"), file("2_b.sql")],
				current: "1",
				pending: [file("2_b.sql")],
			}),
		})
		expect(await applyWithAtlas({ ...options(fake), checkOnly: true })).toEqual(["2_b.sql"])
		expect(commands(fake)).toContain("migrate apply")
		expect(commands(fake)).not.toContain("schema inspect")
	})
})

describe("applyWithAtlas: what it classifies against", () => {
	it("classifies each pending file against the schema the files before it leave", async () => {
		writeFileSync(join(dir, "1_a.sql"), "CREATE TABLE a (id int);\n")
		/* a temp table shadows a only when the history holds a */
		writeFileSync(join(dir, "2_b.sql"), "CREATE TEMP TABLE a (id int);\n")
		const safety: string[] = []
		const later = status({
			applied: [revision("1", { hash: sumHashes(dir).get("1_a.sql") })],
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
		expect(safety).toEqual(["unsafe"])
	})
})

/** 1_a.sql applied as `history`, 2_b.sql pending */
function onHistory(history: string) {
	writeFileSync(join(dir, "1_a.sql"), history)
	const later = status({
		applied: [revision("1", { hash: sumHashes(dir).get("1_a.sql") })],
		available: [file("1_a.sql"), file("2_b.sql")],
		current: "1",
		pending: [file("2_b.sql")],
		status: "PENDING",
	})
	return options(fakeAtlas({ apply: APPLIED, status: later }))
}

describe("applyWithAtlas: a file before a pending one that it cannot read (M75)", () => {
	it("refuses a history file holding a statement Postgres's parser cannot read, by name", async () => {
		const run = onHistory("CREATE TABLE a (id int);\nCREATE TABL b (id int);\n")
		await expect(applyWithAtlas(run)).rejects.toThrow(
			'comb could not read 1_a.sql: "CREATE TABL b (id int)" (syntax error at or near "TABL")',
		)
		expect(run.seen).toEqual([])
	})

	it("refuses a file Atlas cannot split, by name, with Atlas's reason", async () => {
		await expect(applyWithAtlas(onHistory("SELECT (1;\n"))).rejects.toThrow(
			"comb could not read 1_a.sql: Atlas cannot split this file: 1:8: unclosed '('",
		)
	})

	it("rates a pending file the parser cannot read, then refuses the pending file after it", async () => {
		writeFileSync(join(dir, "1_a.sql"), "CREATE TABL b (id int);\n")
		const run = options(fakeAtlas({ apply: APPLIED, status: PENDING }))
		await expect(applyWithAtlas(run)).rejects.toThrow('comb could not read 1_a.sql: "CREATE TABL b (id int)"')
		expect(run.seen).toEqual(["1_a.sql"])
	})
})

/* S1 of the M75 review: the history's read, recorded beside the schema it leaves, serves its facts and the naming check */
describe("applyWithAtlas: each history file parsed once", () => {
	it("parses an applied file once, whatever the pending files after it read of it", async () => {
		const parse = vi.spyOn(postgresParser(), "parseSync")
		try {
			const pending = status({ applied: [revision("1", { hash: "7=" })], current: "1", pending: [file("2_b.sql")] })
			await applyWithAtlas(options(fakeAtlas({ apply: APPLIED, status: pending })))
			expect(parse.mock.calls.filter(([sql]) => sql.includes('CREATE TABLE "a"'))).toHaveLength(1)
		} finally {
			parse.mockRestore()
		}
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
		const silent = fakeAtlas({ status: { code: 137, stderr: "", stdout: "partial" } })
		await expect(applyWithAtlas(options(silent))).rejects.toThrow("atlas migrate status: exit 137: partial")
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

	/* M88: the version as Atlas reads a file name, M76's reader: a file with no description is its version alone */
	it("records the latest file's version, read as Atlas reads it, when the file has no description", () => {
		writeFileSync(join(dir, "3.sql"), 'CREATE TABLE "c" ("id" int);\n')
		writeFileSync(join(dir, "atlas.sum"), "h1:x=\n1_a.sql h1:7=\n2_b.sql h1:7=\n3.sql h1:5=\n")
		const atlas = fakeAtlas({ status: status({}) })
		expect(baselineWithAtlas(options(atlas))).toEqual(["1_a.sql", "2_b.sql", "3.sql"])
		expect(atlas.calls.find((call) => call.args[1] === "set")?.args.slice(0, 3)).toEqual(["migrate", "set", "3"])
	})

	it("compares the database with the history replayed without comb's objects but its sequences", () => {
		writeFileSync(
			join(dir, "1_a.sql"),
			'CREATE SEQUENCE "n";\nCREATE TABLE "a" ("id" int DEFAULT nextval(\'n\'));\nCREATE VIEW "v" AS (select 1);\nCREATE ROLE "r";\n',
		)
		const atlas = fakeAtlas({ status: status({}) })
		baselineWithAtlas(options(atlas))
		expect(atlas.replayed[0]).toBe('CREATE SEQUENCE "n";\nCREATE TABLE "a" ("id" int DEFAULT nextval(\'n\'));\n')
		const diff = atlas.calls.find((call) => call.args[0] === "schema")
		expect(diff?.args.slice(0, 4)).toEqual(["schema", "diff", "--from", "env://url"])
		expect(diff?.env?.["COMB_ATLAS_DEV_URL"]).toBe(`${TARGET.devUrl}?search_path=public`)
	})

	/* M75: the replay is read as Postgres runs it and written so Atlas sends each statement alone */
	it("replays a history Atlas splits by its own delimiter, each statement of a chunk read", () => {
		writeFileSync(
			join(dir, "1_a.sql"),
			'-- atlas:delimiter GO\n\nCREATE ROLE "r"; CREATE TABLE "a" ("id" int)\nGO\nCREATE VIEW "v" AS (select 1)\nGO\n',
		)
		const atlas = fakeAtlas({ status: status({}) })
		baselineWithAtlas(options(atlas))
		expect(atlas.replayed[0]).toBe('CREATE TABLE "a" ("id" int);\n')
	})

	it("records nothing when the database's tables differ from the history's, naming the difference", () => {
		const atlas = fakeAtlas({
			schemaDiff: ok('-- Modify "a" table\nALTER TABLE "a" ADD COLUMN "x" int;\n'),
			status: status({}),
		})
		expect(() => baselineWithAtlas(options(atlas))).toThrow(
			'the database\'s tables are not the ones the migrations leave, so baseline records nothing; the difference:\n-- Modify "a" table\nALTER TABLE "a" ADD COLUMN "x" int;',
		)
		expect(atlas.calls.some((call) => call.args[1] === "set")).toBe(false)
		const broken = fakeAtlas({ schemaDiff: fail("Error: dev database unreachable"), status: status({}) })
		expect(() => baselineWithAtlas(options(broken))).toThrow("atlas schema diff: Error: dev database unreachable")
	})
})

describe("baselineWithAtlas: what it refuses", () => {
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

/* a history whose second applied file is gone: no file of version 9 */
const gone = () =>
	fakeAtlas({ status: status({ applied: [revision("1", { hash: "7=" }), revision("9")], current: "9" }) })

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

	/* G1-a: Atlas's status skips the clean check apply's dry run makes, so status inspects as a check does */
	it("refuses a database holding tables and no history as apply does, and lists every file of an empty one", () => {
		const legacy = ok(JSON.stringify({ schemas: [{ name: "public", tables: [{ name: "legacy" }] }] }))
		expect(() => statusWithAtlas(options(fakeAtlas({ inspect: legacy, status: PENDING })))).toThrow(
			/^the database has objects but no migration history/,
		)
		const empty = options(fakeAtlas({ status: PENDING }))
		statusWithAtlas(empty)
		expect(empty.out).toEqual(["Applied: 0", "Pending: 1_a.sql, 2_b.sql"])
	})

	/* M76 (atlas-history.ts): status names a revision whose file is gone; check and apply refuse it */
	it("names a revision whose file is gone in status, and refuses it in check and apply", async () => {
		const run = options(gone())
		expect(statusWithAtlas(run).applied).toEqual(["1_a.sql", "9"])
		expect(run.out).toEqual(["Applied: 2 (up to 9)", "Pending: none", "9 was applied, and its file is gone or renamed"])
		await expect(applyWithAtlas({ ...options(gone()), checkOnly: true })).rejects.toThrow("9 was applied, and its file")
		await expect(applyWithAtlas(options(gone()))).rejects.toThrow("9 was applied, and its file")
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
