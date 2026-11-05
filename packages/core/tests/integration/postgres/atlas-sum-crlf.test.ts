/**
 * PA19 of r22b, with the pinned Atlas as the oracle: git's autocrlf checks atlas.sum out with CRLF
 * line ends, and Atlas validates that sum as it does the LF one, so comb's snapshot takes it too,
 * and refuses it, as Atlas does, once a file no longer matches it. Sibling: the LF sum.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { hashDir, snapshotDir } from "../../../src/migrate/core/atlas-dir.ts"
import { run } from "../../../src/migrate/core/process.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-sum-crlf-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** Atlas's verdict on `dir`'s sum: ok, or its exit code */
async function atlasValidates(): Promise<string> {
	const ran = await run("atlas", ["migrate", "validate", "--dir", `file://${dir}`])
	return ran.code === 0 ? "ok" : `exit ${ran.code}`
}

/** comb's verdict on `dir`: ok, or its refusal */
async function combSnapshots(): Promise<string> {
	try {
		;(await snapshotDir(run, dir)).remove()
		return "ok"
	} catch (error) {
		return (error as Error).message.replace(dir, "<dir>")
	}
}

describe("a CRLF atlas.sum, as Atlas reads it (PA19 of r22b; sibling: the LF sum)", () => {
	it("is taken while it matches the files, and refused once one is edited, by Atlas and comb alike", async () => {
		writeFileSync(join(dir, "1_a.sql"), "CREATE TABLE a (id int);\n")
		writeFileSync(join(dir, "2_b.sql"), "CREATE TABLE b (id int);\r\n")
		await hashDir(run, dir)
		const sum = join(dir, "atlas.sum")
		writeFileSync(sum, readFileSync(sum, "utf8").replaceAll("\n", "\r\n"))
		expect(readFileSync(sum, "utf8")).toContain("\r\n")
		expect([await atlasValidates(), await combSnapshots()]).toEqual(["ok", "ok"])

		writeFileSync(join(dir, "2_b.sql"), "CREATE TABLE b (id bigint);\r\n")
		const [atlas, comb] = [await atlasValidates(), await combSnapshots()]
		expect(atlas).not.toBe("ok")
		expect(comb).toBe(
			"<dir>/atlas.sum does not match its migrations; if a migration was edited on purpose, run atlas migrate hash",
		)
	})
})
