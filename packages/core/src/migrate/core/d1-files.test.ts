import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { d1Files, refuseSwallowing } from "./d1-files.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-d1-files-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

describe("d1Files: a D1 directory as wrangler reads it", () => {
	it("lists every .sql file by leading number with its text, where that is also Atlas's order", () => {
		writeFileSync(join(dir, "20260102000000_b.sql"), "B;")
		writeFileSync(join(dir, "20260101000000_a.sql"), "A;")
		writeFileSync(join(dir, "atlas.sum"), "")
		expect(d1Files(dir)).toEqual([
			{ name: "20260101000000_a.sql", sql: "A;" },
			{ name: "20260102000000_b.sql", sql: "B;" },
		])
	})
})

/** A check of `sql` as the pending file 2_b.sql */
const refuses = (sql: string) => () => refuseSwallowing([{ name: "2_b.sql", sql }])

describe("refuseSwallowing: a pending file's end, as wrangler appends its history INSERT", () => {
	it("passes a file ending its last statement with ;, whatever comments follow, and one with no statement", () => {
		for (const sql of ["SELECT 1;", "SELECT 1; -- done", "SELECT 1;\n/* done */\n", "", "-- nothing yet\n"])
			expect(refuses(sql)).not.toThrow()
	})

	it("refuses one whose last statement ends unterminated, in code, an identifier or a string", () => {
		for (const sql of ["SELECT 1", 'DROP TABLE "x"', "SELECT 'x'"])
			expect(refuses(sql)).toThrow("2_b.sql does not end its last statement with ;")
	})

	it("refuses one ending inside an open /* comment, with the fix", () => {
		expect(refuses("SELECT 1;\n/* later")).toThrow(
			"2_b.sql ends inside an open /* comment: wrangler appends its history INSERT on the next line, which this would swallow, so the file would run again on every apply; close the comment and end the statement with ;",
		)
	})
})
