/// <reference types="bun-types" />
/**
 * CI on 84332342: whether a --local run met another process's lock is SQLite's own answer for the
 * file, asked by opening it without creating it. Under Bun that open is bun:sqlite's, which takes
 * its options for it, not node:sqlite's `?mode=rw` URI.
 */
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { writeLocked } from "../../src/migrate/drivers/local-db.ts"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-write-locked-bun-"))

describe("writeLocked under Bun", () => {
	it("says true while another connection holds the write lock, and false once it lets go, leaving the file as it was", async () => {
		const file = path.join(dir, "held.sqlite")
		const holder = new Database(file)
		holder.run("CREATE TABLE t (a)")
		holder.run("BEGIN IMMEDIATE")
		const during = await writeLocked(file)
		holder.run("ROLLBACK")
		holder.close()
		const before = fs.readFileSync(file)
		const after = await writeLocked(file)
		expect([during, after, fs.readFileSync(file).equals(before)]).toEqual([true, false, true])
	})

	it("says false, and creates nothing, for a file that is not there", async () => {
		const missing = path.join(dir, "missing.sqlite")
		expect(await writeLocked(missing)).toBe(false)
		expect(fs.existsSync(missing)).toBe(false)
	})
})
