/**
 * What Atlas's apply report tells comb, as Atlas v1.3.0 writes it (P8, P9, P10, P20 of the 0.14.1
 * review): a report naming no file, an error only its JSON holds, a file run outside a transaction
 * that failed partway, and the last version applied.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyWithAtlas, baselineWithAtlas, statusWithAtlas } from "./atlas-apply.ts"
import type { Run } from "./process.ts"
import { fail, fakeAtlas, file, ok, revision, status } from "../../../tests/support/fake-atlas.ts"

const NONE =
	'-- atlas:txmode none\n\nCREATE TABLE "h1" ("id" int);\nCREATE TABLE "h2" ("id" int);\nCREATE TABLE "h1" ("id" int);\n'

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-atlas-report-"))
	writeFileSync(join(dir, "1_a.sql"), 'CREATE TABLE "a" ("id" int);\n')
	writeFileSync(join(dir, "2_b.sql"), NONE)
	writeFileSync(join(dir, "atlas.sum"), "h1:x=\n1_a.sql h1:7=\n2_b.sql h1:7=\n")
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

function options(exec: Run) {
	const out: string[] = []
	return {
		approve: async () => ({ ok: true as const }),
		dir,
		exec,
		out,
		print: (line: string) => out.push(line),
		target: { devUrl: "postgres://localhost/dev", lockTimeout: "5s", schema: "public", url: "postgres://db/app" },
	}
}

const BOTH = [file("1_a.sql"), file("2_b.sql")]
const PENDING = status({ available: BOTH, pending: BOTH, status: "PENDING" })
const DONE = status({ applied: [revision("1"), revision("2")], available: BOTH, current: "2", status: "OK" })
/* Atlas's report when nothing ran, as it writes one after another apply took the lock and ran every file */
const NOTHING = ok(JSON.stringify({ applied: null, error: "", target: "" }))

describe("applyWithAtlas: a report naming no file (P8)", () => {
	it("says there is nothing to apply once another apply ran every pending file", async () => {
		const run = options(fakeAtlas({ apply: NOTHING, status: PENDING, statusAfterApply: DONE }))
		expect(await applyWithAtlas(run)).toEqual([])
		expect(run.out).toEqual(["No migrations to apply"])
	})

	it("refuses an apply that ran nothing, said nothing, and left files pending, naming them", async () => {
		const run = options(fakeAtlas({ apply: NOTHING, status: PENDING, statusAfterApply: PENDING }))
		await expect(applyWithAtlas(run)).rejects.toThrow(
			"atlas migrate apply ran nothing and reported no error, yet still pending: 1_a.sql, 2_b.sql",
		)
	})

	it("reports the error of a report naming no file, such as a mistyped directive", async () => {
		const typo = { applied: null, error: 'unknown txmode "nonee" found in file directive "2_b.sql"', target: "2" }
		const run = options(fakeAtlas({ apply: fail("", JSON.stringify(typo)), status: PENDING }))
		await expect(applyWithAtlas(run)).rejects.toThrow(
			'atlas migrate apply: unknown txmode "nonee" found in file directive "2_b.sql"',
		)
	})
})

describe("applyWithAtlas: a dry run Atlas refused (P9)", () => {
	it("reports the error its JSON holds, else what Atlas wrote to stderr", async () => {
		const json = fail("", JSON.stringify({ applied: null, error: "checksum not found", target: "" }))
		await expect(applyWithAtlas(options(fakeAtlas({ dryRun: json, status: PENDING })))).rejects.toThrow(
			"atlas migrate apply --dry-run: checksum not found",
		)
		const text = fail("Error: checksum mismatch", "You have a checksum error in your migration directory.\n")
		await expect(applyWithAtlas(options(fakeAtlas({ dryRun: text, status: PENDING })))).rejects.toThrow(
			"atlas migrate apply --dry-run: Error: checksum mismatch",
		)
	})
})

/** Atlas's report when 2_b.sql failed at its statement `at`, counted from 1 */
function failedAt(at: number) {
	const statements = NONE.split("\n").filter((line) => line.startsWith("CREATE"))
	const failed = {
		Applied: statements.slice(0, at),
		Error: { Stmt: statements[at - 1], Text: 'pq: relation "h1" already exists (42P07)' },
		Name: "2_b.sql",
	}
	const applied = [{ Applied: ['CREATE TABLE "a" ("id" int);'], Name: "1_a.sql" }, failed]
	return fail("", JSON.stringify({ applied, error: "sql/migrate: executing statement", target: "2" }))
}

describe("applyWithAtlas: a file run outside a transaction that failed (P10)", () => {
	it("says the statements it ran before the failure stay, and that apply resumes after them", async () => {
		await expect(applyWithAtlas(options(fakeAtlas({ apply: failedAt(3), status: PENDING })))).rejects.toThrow(
			'2_b.sql failed at CREATE TABLE "h1" ("id" int);: pq: relation "h1" already exists (42P07). It ran outside a transaction, so the 2 statements it ran before that stay applied, as do the files before it; while the file is unchanged, migrate apply resumes after them',
		)
	})

	it("says the one statement it ran before the failure stays", async () => {
		await expect(applyWithAtlas(options(fakeAtlas({ apply: failedAt(2), status: PENDING })))).rejects.toThrow(
			"It ran outside a transaction, so the statement it ran before that stays applied, as do the files before it",
		)
	})

	/*
	 * 27.5 of plan 15: on a resume Atlas lists only this run's statements, and counts the earlier run's
	 * as Skipped, a statement count: 2 after a file ran 2 of its statements and failed at its third
	 * (Atlas v1.3.0, .tmp/grunt/r16/p14/skipped-probe.log)
	 */
	it("counts the statements an earlier run applied, which a resume skips", async () => {
		const statements = NONE.split("\n").filter((line) => line.startsWith("CREATE"))
		const resumed = {
			Applied: [statements[2]],
			Error: { Stmt: statements[2], Text: 'pq: relation "h1" already exists (42P07)' },
			Name: "2_b.sql",
			Skipped: 2,
		}
		const apply = fail(
			"",
			JSON.stringify({ applied: [resumed], error: "sql/migrate: executing statement", target: "2" }),
		)
		await expect(applyWithAtlas(options(fakeAtlas({ apply, status: PENDING })))).rejects.toThrow(
			"It ran outside a transaction, so the 2 statements it ran before that stay applied, as do the files before it",
		)
	})

	it("says nothing of it stays when its first statement failed", async () => {
		await expect(applyWithAtlas(options(fakeAtlas({ apply: failedAt(1), status: PENDING })))).rejects.toThrow(
			'2_b.sql failed at CREATE TABLE "h1" ("id" int);: pq: relation "h1" already exists (42P07). It ran outside a transaction and failed at its first statement, so nothing of it stays applied; the files before it do',
		)
	})
})

describe("the last version a database records (P20)", () => {
	/* Atlas's current, when it holds its placeholder for no version, as a history it could not place leaves it */
	const placed = status({
		applied: [revision("1", { hash: "7=" })],
		available: BOTH,
		current: "No migration applied yet",
		pending: [file("2_b.sql")],
		status: "PENDING",
	})

	it("is the last applied revision's, not Atlas's current", async () => {
		await expect(baselineWithAtlas(options(fakeAtlas({ status: placed })))).rejects.toThrow(
			"the database already records 1 migration (up to 1); baseline marks a database that has none",
		)
		const run = options(fakeAtlas({ status: placed }))
		statusWithAtlas(run)
		expect(run.out).toEqual(["Applied: 1 (up to 1)", "Pending: 2_b.sql"])
	})
})
