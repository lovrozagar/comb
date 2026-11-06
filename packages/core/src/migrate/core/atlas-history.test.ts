/**
 * M76 of the 0.13.0 round: the Postgres history against the snapshot. Atlas maps a revision to its
 * file by version, and hashes each file over its name and the files before it, so a rename under
 * the version, a gone file and an edit are each named for what they are, checked in that order.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sqlFiles } from "./atlas-dir.ts"
import { type AtlasRevision, type AtlasStatus, checkHistory, fileOf } from "./atlas-history.ts"
import { file } from "../../../tests/support/fake-atlas.ts"

let dir = ""
/** A scrub that keeps the text: these histories hold no secret */
const kept = (text: string) => text
/** A scrub of the one secret these tests hold */
const masked = (text: string) => text.replaceAll("S3cret", "***")
/** `files` as the snapshot, its sum hashed as `h1:<name length>=` for each */
function snapshot(files: Record<string, string>): void {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	const lines = sqlFiles(dir).map((name) => `${name} h1:${name.length}=`)
	writeFileSync(join(dir, "atlas.sum"), `h1:x=\n${lines.join("\n")}\n`)
}
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-atlas-history-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** A revision Atlas recorded for `name`, its hash the sum's for that name unless `hash` says otherwise */
function applied(name: string, hash?: string): AtlasRevision {
	const [version = "", description = ""] = name.replace(/\.sql$/, "").split(/_(.*)/s)
	return {
		applied: 1,
		description,
		error: "",
		errorStmt: "",
		hash: hash ?? `${name.length}=`,
		total: 1,
		type: "applied",
		version,
	}
}

const history = (revisions: AtlasRevision[]): AtlasStatus => ({
	applied: revisions,
	available: [],
	current: revisions.at(-1)?.version ?? "",
	error: "",
	pending: [],
	status: "OK",
})

/** What status prints of `status` against the snapshot: its gone files, after any refusal */
function named(status: AtlasStatus): string[] {
	const lines: string[] = []
	checkHistory(status, dir, { gone: (line) => lines.push(line), scrub: kept })
	return lines
}

describe("an applied file gone, or renamed to another version", () => {
	it("is named by its version: printed in status, refused in check and apply, all of them at once", () => {
		snapshot({ "3_c.sql": "SELECT 3;\n" })
		const gone = history([applied("1_a.sql"), applied("2_b.sql"), applied("3_c.sql")])
		expect(named(gone)).toEqual([
			"1 was applied, and its file is gone or renamed",
			"2 was applied, and its file is gone or renamed",
		])
		expect(() => checkHistory(gone, dir, { scrub: kept })).toThrow(
			"1 was applied, and its file is gone or renamed; 2 was applied, and its file is gone or renamed",
		)
	})

	it("names the file that went, not the next one, whose cumulative hash changed with it", () => {
		snapshot({ "2_b.sql": "SELECT 2;\n" })
		const status = history([applied("1_a.sql"), applied("2_b.sql", "other=")])
		expect(named(status)).toEqual(["1 was applied, and its file is gone or renamed"])
		expect(() => checkHistory(status, dir, { scrub: kept })).toThrow(/^1 was applied, and its file is gone or renamed$/)
	})

	/* the gone row is what Atlas calls a later file out of order for, so its refusal wins over Atlas's error (M78) */
	it("refuses a gone file before Atlas's out-of-order error, in check and apply and in status", () => {
		snapshot({ "1_a.sql": "SELECT 1;\n", "3_c.sql": "SELECT 3;\n" })
		const status = {
			...history([applied("1_a.sql"), applied("5_e.sql")]),
			error: "migration file 3_c.sql was added out of order",
		}
		const gone = /^5 was applied, and its file is gone or renamed$/
		expect(() => checkHistory(status, dir, { scrub: kept })).toThrow(gone)
		expect(() => named(status)).toThrow(gone)
	})

	it("refuses the last applied file renamed to a new version, the file Atlas then lists as pending", () => {
		snapshot({ "1_a.sql": "SELECT 1;\n", "3_b.sql": "SELECT 2;\n" })
		expect(() => checkHistory(history([applied("1_a.sql"), applied("2_b.sql")]), dir, { scrub: kept })).toThrow(
			"2 was applied, and its file is gone or renamed",
		)
	})
})

/* ruling (a): Atlas's hash covers the name, so a rename under the version is refused by name, never accepted */
/* M79: checkHistory decides on Atlas's raw text and scrubs only what it prints */
describe("what checkHistory prints of Atlas's text", () => {
	it("scrubs the halfway file's failed statement and error, and Atlas's error, with the report's scrub", () => {
		snapshot({ "1_a.sql": "SELECT 1;\n" })
		const half = { ...applied("1_a.sql"), applied: 1, error: "pq: S3cret", errorStmt: "SELECT 'S3cret'", total: 2 }
		expect(checkHistory(history([half]), dir, { scrub: masked })).toBe(
			"1_a.sql ran 1 of its 2 statements before it failed at SELECT '***' (pq: ***)",
		)
		expect(() => checkHistory({ ...history([]), error: "dial S3cret" }, dir, { scrub: masked })).toThrow(
			"atlas migrate status: dial ***",
		)
	})

	/* PA20; sibling: apply's failed statement (P17 of the 0.15.0 review) */
	it("drops the failed statement's own semicolon, which reads as the sentence's before the (", () => {
		snapshot({ "1_a.sql": "SELECT 1;\nINSERT INTO m VALUES (1);\n" })
		const half = {
			...applied("1_a.sql"),
			applied: 1,
			error: "pq: no m",
			errorStmt: "INSERT INTO m VALUES (1);\n",
			total: 2,
		}
		expect(checkHistory(history([half]), dir, { scrub: kept })).toBe(
			"1_a.sql ran 1 of its 2 statements before it failed at INSERT INTO m VALUES (1) (pq: no m)",
		)
	})
})

describe("an applied file renamed under its version, or edited", () => {
	it("refuses a rename by both names, the first of three too, before the hashes the rename changed", () => {
		snapshot({ "1_z.sql": "SELECT 1;\n", "2_b.sql": "SELECT 2;\n", "3_c.sql": "SELECT 3;\n" })
		const status = history([applied("1_a.sql"), applied("2_b.sql", "other="), applied("3_c.sql", "other=")])
		const refusal = "1 was applied as 1_a.sql and is now 1_z.sql; restore its name"
		expect(() => named(status)).toThrow(refusal)
		expect(() => checkHistory(status, dir, { scrub: kept })).toThrow(refusal)
	})

	/* M17 of the 0.12 round: as on SQLite, an applied file edited since is refused, not a warning */
	it("refuses an applied file that changed since, in status, check and apply", () => {
		snapshot({ "1_a.sql": "SELECT 1;\n" })
		const refusal = /^1_a\.sql was applied, then edited: its hash is not the one Atlas recorded/
		expect(() => named(history([applied("1_a.sql", "other=")]))).toThrow(refusal)
		expect(() => checkHistory(history([applied("1_a.sql", "other=")]), dir, { scrub: kept })).toThrow(refusal)
	})

	/* PA19 of r22b: a CRLF atlas.sum, as git's autocrlf checks one out, holds the same refusal; sibling: the LF sum */
	it("refuses it under a CRLF atlas.sum, and passes the unedited file", () => {
		snapshot({ "1_a.sql": "SELECT 1;\n" })
		writeFileSync(join(dir, "atlas.sum"), readFileSync(join(dir, "atlas.sum"), "utf8").replaceAll("\n", "\r\n"))
		expect(() => checkHistory(history([applied("1_a.sql", "other=")]), dir, { scrub: kept })).toThrow(
			/^1_a\.sql was applied, then edited/,
		)
		expect(checkHistory(history([applied("1_a.sql")]), dir, { scrub: kept })).toBeUndefined()
	})

	it("reads a file named by its version alone, so a rename to or from it and its edit are refused", () => {
		snapshot({ "1.sql": "SELECT 1;\n" })
		expect(() => checkHistory(history([applied("1_a.sql")]), dir, { scrub: kept })).toThrow(
			"1 was applied as 1_a.sql and is now 1.sql; restore its name",
		)
		expect(() => checkHistory(history([applied("1.sql", "other=")]), dir, { scrub: kept })).toThrow(
			/^1\.sql was applied, then edited/,
		)
		expect(named(history([applied("1.sql")]))).toEqual([])
		rmSync(join(dir, "1.sql"))
		snapshot({ "1_a.sql": "SELECT 1;\n" })
		expect(() => checkHistory(history([applied("1.sql")]), dir, { scrub: kept })).toThrow(
			"1 was applied as 1.sql and is now 1_a.sql; restore its name",
		)
	})

	it("maps a revision to its file by version, and to the version when no file has it", () => {
		snapshot({ "1.sql": "SELECT 1;\n", "10_a.sql": "SELECT 10;\n", "2_a_b.sql": "SELECT 2;\n" })
		expect([fileOf(dir, "1"), fileOf(dir, "10"), fileOf(dir, "2"), fileOf(dir, "3")]).toEqual([
			"1.sql",
			"10_a.sql",
			"2_a_b.sql",
			"3",
		])
		expect(named(history([applied("2_a_b.sql")]))).toEqual([])
	})
})

/** `name`, which Atlas ran 1 of its 3 statements of, outside a transaction, recording `hash` */
const half = (name: string, hash: string): AtlasRevision => ({
	...applied(name, hash),
	error: "pq: relation exists",
	errorStmt: "SELECT 2",
	total: 3,
})

/*
 * P11 of the 0.14.1 review: Atlas's hashes chain, so a change before a file it ran halfway changes
 * that file's hash too; the earlier file is named for it. Restoring the half-run file resumes it at
 * the statement that failed, as Atlas v1.3.0 does (.tmp/grunt/r16/p14/probe.log), so that is the remedy.
 */
describe("a file Atlas ran halfway, after a change to an earlier file (P11)", () => {
	const files = { "1_a.sql": "SELECT 1;\n", "2_b.sql": "SELECT 2;\n" }

	it("names an earlier file edited since, not the half-run one", () => {
		snapshot(files)
		const status = history([applied("1_a.sql", "other="), half("2_b.sql", "other=")])
		expect(() => checkHistory(status, dir, { scrub: kept })).toThrow(
			"1_a.sql was applied, then edited: its hash is not the one Atlas recorded",
		)
	})

	it("names an earlier file gone, in status too", () => {
		snapshot({ "2_b.sql": files["2_b.sql"] })
		const status = history([applied("1_a.sql"), half("2_b.sql", "other=")])
		expect(() => checkHistory(status, dir, { scrub: kept })).toThrow(/^1 was applied, and its file is gone or renamed$/)
		expect(named(status)).toEqual(["1 was applied, and its file is gone or renamed"])
	})

	/*
	 * 27.5 of plan 15, by name since leaf 16.3 (a) of plan 21: Atlas v1.3.0 lists a late file in neither
	 * `available` nor pending (.tmp/grunt/r16/p14/status-probe.log), so ownHistory lists the snapshot's
	 * files and drops Atlas's out-of-order error, and the late file is named, not the half-run one
	 */
	it("names an earlier file added since, as one named before a file applied", () => {
		snapshot(files)
		const status = { ...history([half("2_b.sql", "other=")]), available: [file("1_a.sql"), file("2_b.sql")] }
		expect(() => checkHistory(status, dir, { scrub: kept })).toThrow(
			"1_a.sql was never applied, yet it sorts before 2_b.sql, which was",
		)
	})

	it("takes the half-run file's own error, which Atlas's status repeats, as no other error", () => {
		snapshot(files)
		const half2 = half("2_b.sql", "7=")
		const status = { ...history([applied("1_a.sql"), half2]), error: half2.error }
		expect(checkHistory(status, dir, { scrub: kept })).toContain("2_b.sql ran 1 of its 3 statements")
	})

	it("refuses the half-run file changed since, saying restoring it resumes at the statement that failed", () => {
		snapshot(files)
		expect(() => checkHistory(history([applied("1_a.sql"), half("2_b.sql", "other=")]), dir, { scrub: kept })).toThrow(
			"2_b.sql ran 1 of its 3 statements before it failed at SELECT 2 (pq: relation exists), outside a transaction, and has changed since; restore it: migrate apply resumes at the statement that failed, so fix what made it fail, in the database, first",
		)
	})
})

/*
 * leaf 16.3 (a) of plan 21 (migrate-pg-atlas_flow_names): the name is the only order, as on SQLite,
 * and Atlas resumes a file it ran halfway outside a transaction only while its version, as text, is
 * the highest recorded (.tmp/grunt/p21/areas/ae3/exo/probe4.log)
 */
/** `status` listing the snapshot's files, as ownHistory hands it */
const listing = (status: AtlasStatus, ...pending: string[]): AtlasStatus => ({
	...status,
	available: sqlFiles(dir).map(file),
	pending: pending.map(file),
})

const NONE = "-- atlas:txmode none\n\nSELECT 1;\n"

/** The refusal of 20260101_none.sql below `name`'s version */
const below = (name: string) =>
	`20260101_none.sql runs outside a transaction (atlas:txmode none), yet its version sorts below ${name}'s, which runs before it`

describe("the history by name", () => {
	it("refuses a file named before the last applied one, whatever its version, its name masked", () => {
		snapshot({ "1.5_a.sql": "SELECT 1;\n", "1_b.sql": "SELECT 2;\n" })
		expect(() => checkHistory(listing(history([applied("1_b.sql")])), dir, { scrub: kept })).toThrow(
			"1.5_a.sql was never applied, yet it sorts before 1_b.sql, which was; rename it to sort after the applied files and run atlas migrate hash",
		)
		for (const name of ["1.5_a.sql", "1_b.sql"]) rmSync(join(dir, name))
		snapshot({ "1_S3cret.sql": "SELECT 1;\n", "2_b.sql": "SELECT 2;\n" })
		expect(() => checkHistory(listing(history([applied("2_b.sql")])), dir, { scrub: masked })).toThrow(
			/^1_\*\*\*\.sql was never applied, yet it sorts before 2_b\.sql/,
		)
	})

	it("passes files applied by name whose versions sort otherwise, 20260101000000_b before 20260101_a", () => {
		snapshot({
			"20260101000000_b.sql": "SELECT 1;\n",
			"20260101_a.sql": "SELECT 2;\n",
			"20260102_c.sql": "SELECT 3;\n",
		})
		const status = listing(history([applied("20260101000000_b.sql"), applied("20260101_a.sql")]), "20260102_c.sql")
		expect(checkHistory(status, dir, { scrub: kept })).toBeUndefined()
	})

	it("names the gone file, not a file named before it, in status too", () => {
		snapshot({ "15_z.sql": "SELECT 1;\n", "1_a.sql": "SELECT 2;\n" })
		const status = listing(history([applied("1_a.sql"), applied("2_b.sql")]))
		expect(() => named(status)).toThrow(/^2 was applied, and its file is gone or renamed$/)
	})
})

describe("a txmode none file Atlas would not resume", () => {
	it("refuses a half-run file whose version sorts below another applied, which Atlas will not resume", () => {
		snapshot({ "20260101000000_b.sql": "SELECT 1;\n", "20260101_half.sql": NONE })
		const status = listing(
			history([applied("20260101000000_b.sql"), half("20260101_half.sql", "17=")]),
			"20260101_half.sql",
		)
		expect(() => checkHistory(status, dir, { scrub: kept })).toThrow(
			"20260101_half.sql ran 1 of its 3 statements outside a transaction, and Atlas will not resume it: it resumes such a file only while its version is the highest applied, and 20260101 sorts below 20260101000000_b.sql's; run its remaining statements by hand, then set its applied count to 3 and its error to '' in its row of Atlas's atlas_schema_revisions table",
		)
	})

	it("refuses a pending txmode none file whose version sorts below one applied or run before it", () => {
		snapshot({ "20260101000000_b.sql": "SELECT 1;\n", "20260101_none.sql": NONE, "2026_x.sql": "SELECT 2;\n" })
		expect(() =>
			checkHistory(listing(history([applied("20260101000000_b.sql")]), "20260101_none.sql", "2026_x.sql"), dir, {
				scrub: kept,
			}),
		).toThrow(below("20260101000000_b.sql"))
		expect(() =>
			checkHistory(listing(history([]), "20260101000000_b.sql", "20260101_none.sql", "2026_x.sql"), dir, {
				scrub: kept,
			}),
		).toThrow(below("20260101000000_b.sql"))
	})

	it("passes a txmode none file whose version is the highest so far, and a transactional one below", () => {
		snapshot({ "20260101000000_b.sql": "SELECT 1;\n", "20260101_a.sql": "SELECT 2;\n", "20260102_none.sql": NONE })
		const status = listing(history([applied("20260101000000_b.sql")]), "20260101_a.sql", "20260102_none.sql")
		expect(checkHistory(status, dir, { scrub: kept })).toBeUndefined()
		const resuming = listing(
			history([applied("20260101000000_b.sql"), applied("20260101_a.sql"), half("20260102_none.sql", "17=")]),
			"20260102_none.sql",
		)
		expect(checkHistory(resuming, dir, { scrub: kept })).toContain("20260102_none.sql ran 1 of its 3 statements")
	})
})
