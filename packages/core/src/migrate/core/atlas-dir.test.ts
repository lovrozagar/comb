import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { freshVersion, hashDir, nextVersion, snapshotDir, sqlFiles, sumHashes, verifySum } from "./atlas-dir.ts"
import type { Run, RunResult } from "./process.ts"

const ok = (stdout = ""): RunResult => ({ code: 0, stderr: "", stdout })

/** `atlas migrate hash` as a fake: the sum lists each file with its length as the hash */
const fakeHash: Run = async (_cmd, args) => {
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
	it("lists the .sql files in name order, and reads each file's hash from atlas.sum", async () => {
		writeFileSync(join(dir, "2_b.sql"), "")
		writeFileSync(join(dir, "1_a.sql"), "")
		writeFileSync(join(dir, "notes.md"), "")
		expect(sqlFiles(dir)).toEqual(["1_a.sql", "2_b.sql"])
		await hashDir(fakeHash, dir)
		expect(sumHashes(dir)).toEqual(
			new Map([
				["1_a.sql", "7="],
				["2_b.sql", "7="],
			]),
		)
	})

	it("reads no hashes from a directory without atlas.sum", async () => {
		expect(sumHashes(dir)).toEqual(new Map())
	})
})

describe("hashDir and verifySum", () => {
	it("throws atlas's failure to hash, without its trailing newline (K6 of r21)", async () => {
		await expect(hashDir(async () => ({ code: 1, stderr: "no dir\n", stdout: "" }), dir)).rejects.toThrow(
			new Error("atlas migrate hash failed: no dir"),
		)
	})

	it("accepts a sum that matches the files and refuses one that does not", async () => {
		writeFileSync(join(dir, "1_a.sql"), "")
		await hashDir(fakeHash, dir)
		await expect(verifySum(fakeHash, dir)).resolves.toBeUndefined()
		writeFileSync(join(dir, "22_late.sql"), "")
		await expect(verifySum(fakeHash, dir)).rejects.toThrow(`${dir}/atlas.sum does not match its migrations`)
	})
})

/* S9 and K3 of the 0.15.0 review: what `comb migrate init` makes holds no file and no sum */
describe("verifySum and snapshotDir on a directory without atlas.sum", () => {
	it("take a directory with no migration as an empty history", async () => {
		await expect(verifySum(fakeHash, dir)).resolves.toBeUndefined()
		const copy = await snapshotDir(fakeHash, dir)
		try {
			expect(readdirSync(copy.dir)).toEqual([])
		} finally {
			copy.remove()
		}
	})

	it("refuse migrations with no sum, naming comb migrate diff", async () => {
		writeFileSync(join(dir, "1_a.sql"), "CREATE TABLE a (x int);")
		const refusal = `${dir} has migrations but no atlas.sum; comb migrate diff writes a migration and its sum, and atlas migrate hash --dir file://${dir} hashes ones written by hand`
		await expect(verifySum(fakeHash, dir)).rejects.toThrow(refusal)
		await expect(snapshotDir(fakeHash, dir)).rejects.toThrow(refusal)
	})
})

describe("snapshotDir", () => {
	it("copies the migrations and atlas.sum into a private directory, checked against the sum", async () => {
		writeFileSync(join(dir, "1_a.sql"), "")
		writeFileSync(join(dir, "README.md"), "")
		await hashDir(fakeHash, dir)
		const copy = await snapshotDir(fakeHash, dir)
		try {
			expect(readdirSync(copy.dir).sort()).toEqual(["1_a.sql", "atlas.sum"])
			expect(statSync(copy.dir).mode & 0o777).toBe(0o700)
		} finally {
			copy.remove()
		}
	})

	/* the copy goes under a temp dir of this test's own: the shared one holds other runs' copies,
	   which come and go while this one counts (a verify failed so, finding one gone) */
	it("refuses a directory whose sum does not match, and leaves no copy behind", async () => {
		writeFileSync(join(dir, "1_a.sql"), "")
		await hashDir(fakeHash, dir)
		writeFileSync(join(dir, "2_b.sql"), "")
		const own = mkdtempSync(join(tmpdir(), "comb-atlas-tmp-"))
		const shared = process.env["TMPDIR"]
		process.env["TMPDIR"] = own
		try {
			await expect(snapshotDir(fakeHash, dir)).rejects.toThrow(`${dir}/atlas.sum does not match its migrations`)
			expect(readdirSync(own).filter((name) => name.startsWith("comb-migrate-snapshot-"))).toEqual([])
		} finally {
			if (shared === undefined) delete process.env["TMPDIR"]
			else process.env["TMPDIR"] = shared
			rmSync(own, { force: true, recursive: true })
		}
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
