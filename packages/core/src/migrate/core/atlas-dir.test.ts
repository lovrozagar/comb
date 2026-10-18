import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { freshVersion, hashDir, nextVersion, snapshotDir, sqlFiles, sumHashes, verifySum } from "./atlas-dir.ts"
import type { Run, RunResult } from "./process.ts"

const ok = (stdout = ""): RunResult => ({ code: 0, stderr: "", stdout })

/** `atlas migrate hash` as a fake: the sum lists each file with its length as the hash */
const fakeHash: Run = (_cmd, args) => {
	const dir = (args[args.indexOf("--dir") + 1] as string).replace("file://", "")
	const lines = sqlFiles(dir).map((file) => `${file} h1:${file.length}=`)
	writeFileSync(join(dir, "atlas.sum"), `h1:total=\n${lines.join("\n")}\n`)
	return ok()
}

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-atlas-dir-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

describe("sqlFiles and sumHashes", () => {
	it("lists the .sql files in name order, and reads each file's hash from atlas.sum", () => {
		writeFileSync(join(dir, "2_b.sql"), "")
		writeFileSync(join(dir, "1_a.sql"), "")
		writeFileSync(join(dir, "notes.md"), "")
		expect(sqlFiles(dir)).toEqual(["1_a.sql", "2_b.sql"])
		hashDir(fakeHash, dir)
		expect(sumHashes(dir)).toEqual(
			new Map([
				["1_a.sql", "7="],
				["2_b.sql", "7="],
			]),
		)
	})

	it("reads no hashes from a directory without atlas.sum", () => {
		expect(sumHashes(dir)).toEqual(new Map())
	})
})

describe("hashDir and verifySum", () => {
	it("throws atlas's failure to hash", () => {
		expect(() => hashDir(() => ({ code: 1, stderr: "no dir", stdout: "" }), dir)).toThrow(
			"atlas migrate hash failed: no dir",
		)
	})

	it("accepts a sum that matches the files and refuses one that does not", () => {
		writeFileSync(join(dir, "1_a.sql"), "")
		hashDir(fakeHash, dir)
		expect(() => verifySum(fakeHash, dir)).not.toThrow()
		writeFileSync(join(dir, "22_late.sql"), "")
		expect(() => verifySum(fakeHash, dir)).toThrow(`${dir}/atlas.sum does not match its migrations`)
	})
})

describe("snapshotDir", () => {
	it("copies the migrations and atlas.sum into a private directory, checked against the sum", () => {
		writeFileSync(join(dir, "1_a.sql"), "")
		writeFileSync(join(dir, "README.md"), "")
		hashDir(fakeHash, dir)
		const copy = snapshotDir(fakeHash, dir)
		try {
			expect(readdirSync(copy).sort()).toEqual(["1_a.sql", "atlas.sum"])
			expect(statSync(copy).mode & 0o777).toBe(0o700)
		} finally {
			rmSync(copy, { force: true, recursive: true })
		}
	})

	it("refuses a directory whose sum does not match, and leaves no copy behind", () => {
		writeFileSync(join(dir, "1_a.sql"), "")
		hashDir(fakeHash, dir)
		writeFileSync(join(dir, "2_b.sql"), "")
		const before = readdirSync(tmpdir()).filter((name) => name.startsWith("comb-migrate-snapshot-")).length
		expect(() => snapshotDir(fakeHash, dir)).toThrow(`${dir}/atlas.sum does not match its migrations`)
		expect(readdirSync(tmpdir()).filter((name) => name.startsWith("comb-migrate-snapshot-"))).toHaveLength(before)
	})
})

describe("nextVersion and freshVersion", () => {
	it("steps a version one second, across a year", () => {
		expect(nextVersion("20261231235959")).toBe("20270101000000")
	})

	it("takes now in an empty directory or one behind it, and a second past the latest otherwise", () => {
		const now = new Date("2026-10-18T12:00:00Z")
		expect(freshVersion(dir, now)).toBe("20261018120000")
		writeFileSync(join(dir, "20261018115959_a.sql"), "")
		writeFileSync(join(dir, "manual.sql"), "")
		expect(freshVersion(dir, now)).toBe("20261018120000")
		writeFileSync(join(dir, "20261018120000_b.sql"), "")
		expect(freshVersion(dir, now)).toBe("20261018120001")
	})
})
