import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openFileDatabase } from "./file-open.ts"
import { DatabaseMissing } from "./missing.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "comb-file-open-"))
	dirs.push(dir)
	return dir
}

/* D6-7 of the area D round-six review: the open both file drivers share */
describe("openFileDatabase", () => {
	it("makes a writable database's folder before it opens, and gives what the open gave", async () => {
		const file = join(temp(), "missing", "sub", "core.db")
		const seen = await openFileDatabase(file, false, () => existsSync(join(file, "..")))
		expect(seen).toBe(true)
	})

	it("refuses a read-only open of a missing file, making no folder and opening nothing", async () => {
		const dir = temp()
		let opened = false
		const file = join(dir, "missing", "core.db")
		const refused = openFileDatabase(file, true, () => (opened = true))
		await expect(refused).rejects.toBeInstanceOf(DatabaseMissing)
		await expect(refused).rejects.toThrow(
			`${file} does not exist; check and status open a database read-only, and create none`,
		)
		expect([opened, existsSync(join(dir, "missing"))]).toEqual([false, false])
	})

	it("names the path it tried when the open fails, keeping the engine's error as the cause", async () => {
		const file = join(temp(), "core.db")
		const engine = new Error("unable to open database file")
		writeFileSync(file, "")
		const failed = openFileDatabase(file, true, () => {
			throw engine
		})
		await expect(failed).rejects.toThrow(`cannot open the SQLite database ${file}: unable to open database file`)
		await expect(failed).rejects.toHaveProperty("cause", engine)
	})

	it("names the path when its folder cannot be made", async () => {
		const dir = temp()
		writeFileSync(join(dir, "taken"), "")
		const file = join(dir, "taken", "core.db")
		await expect(openFileDatabase(file, false, () => "opened")).rejects.toThrow(
			`cannot open the SQLite database ${file}: `,
		)
	})

	it("keeps the engine's error code, as a caller reading a failed connect's code reads it", async () => {
		const file = join(temp(), "core.db")
		const failed = openFileDatabase(file, false, () => {
			throw Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" })
		})
		await expect(failed).rejects.toMatchObject({
			code: "SQLITE_CANTOPEN",
			message: `cannot open the SQLite database ${file}: unable to open database file`,
		})
	})

	it("gives no code when the engine's error has no string code", async () => {
		const failed = openFileDatabase(join(temp(), "core.db"), false, () => {
			throw Object.assign(new Error("odd"), { code: 14 })
		})
		await expect(failed).rejects.not.toHaveProperty("code")
	})
})
