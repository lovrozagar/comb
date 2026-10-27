/**
 * M76 of the 0.13.0 round: the Postgres history against the snapshot. Atlas maps a revision to its
 * file by version, and hashes each file over its name and the files before it, so a rename under
 * the version, a gone file and an edit are each named for what they are, checked in that order.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sqlFiles } from "./atlas-dir.ts"
import { type AtlasRevision, type AtlasStatus, checkHistory, fileOf } from "./atlas-history.ts"

let dir = ""
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
	checkHistory(status, dir, (line) => lines.push(line))
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
		expect(() => checkHistory(gone, dir)).toThrow(
			"1 was applied, and its file is gone or renamed; 2 was applied, and its file is gone or renamed",
		)
	})

	it("names the file that went, not the next one, whose cumulative hash changed with it", () => {
		snapshot({ "2_b.sql": "SELECT 2;\n" })
		const status = history([applied("1_a.sql"), applied("2_b.sql", "other=")])
		expect(named(status)).toEqual(["1 was applied, and its file is gone or renamed"])
		expect(() => checkHistory(status, dir)).toThrow(/^1 was applied, and its file is gone or renamed$/)
	})

	it("refuses the last applied file renamed to a new version, the file Atlas then lists as pending", () => {
		snapshot({ "1_a.sql": "SELECT 1;\n", "3_b.sql": "SELECT 2;\n" })
		expect(() => checkHistory(history([applied("1_a.sql"), applied("2_b.sql")]), dir)).toThrow(
			"2 was applied, and its file is gone or renamed",
		)
	})
})

/* ruling (a): Atlas's hash covers the name, so a rename under the version is refused by name, never accepted */
describe("an applied file renamed under its version, or edited", () => {
	it("refuses a rename by both names, the first of three too, before the hashes the rename changed", () => {
		snapshot({ "1_z.sql": "SELECT 1;\n", "2_b.sql": "SELECT 2;\n", "3_c.sql": "SELECT 3;\n" })
		const status = history([applied("1_a.sql"), applied("2_b.sql", "other="), applied("3_c.sql", "other=")])
		const refusal = "1 was applied as 1_a.sql and is now 1_z.sql; restore its name"
		expect(() => named(status)).toThrow(refusal)
		expect(() => checkHistory(status, dir)).toThrow(refusal)
	})

	/* M17 of the 0.12 round: as on SQLite, an applied file edited since is refused, not a warning */
	it("refuses an applied file that changed since, in status, check and apply", () => {
		snapshot({ "1_a.sql": "SELECT 1;\n" })
		const refusal = /^1_a\.sql was applied, then edited: its hash is not the one Atlas recorded/
		expect(() => named(history([applied("1_a.sql", "other=")]))).toThrow(refusal)
		expect(() => checkHistory(history([applied("1_a.sql", "other=")]), dir)).toThrow(refusal)
	})

	it("reads a file named by its version alone, so a rename to or from it and its edit are refused", () => {
		snapshot({ "1.sql": "SELECT 1;\n" })
		expect(() => checkHistory(history([applied("1_a.sql")]), dir)).toThrow(
			"1 was applied as 1_a.sql and is now 1.sql; restore its name",
		)
		expect(() => checkHistory(history([applied("1.sql", "other=")]), dir)).toThrow(/^1\.sql was applied, then edited/)
		expect(named(history([applied("1.sql")]))).toEqual([])
		rmSync(join(dir, "1.sql"))
		snapshot({ "1_a.sql": "SELECT 1;\n" })
		expect(() => checkHistory(history([applied("1.sql")]), dir)).toThrow(
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
