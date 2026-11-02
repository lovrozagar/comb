/**
 * The e2e harness makes its scratch apps inside packages/core (tests/e2e/support/project.ts). A
 * run that is killed leaves them there, so git and lint must never see one, and the next run
 * sweeps the ones left behind.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { STALE_MS, sweep } from "../e2e/support/project.ts"

const CORE = join(import.meta.dirname, "../..")
const ROOT = join(CORE, "../..")

const planted: string[] = []
afterEach(() => {
	for (const dir of planted.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** A scratch app as a killed run leaves it: a table file importing what it never uses, aged `ageMs` */
function leftover(ageMs: number): string {
	const dir = mkdtempSync(join(CORE, ".e2e-"))
	planted.push(dir)
	mkdirSync(join(dir, "src/db"), { recursive: true })
	writeFileSync(
		join(dir, "src/db/core.tables.ts"),
		`import { int, text } from "drizzle-orm/sqlite-core"\nexport const n = int\n`,
	)
	const at = new Date(Date.now() - ageMs)
	utimesSync(dir, at, at)
	return dir
}

describe("e2e scratch apps", () => {
	it("a killed run's app is ignored by git and passes root lint", () => {
		const dir = leftover(0)
		expect(spawnSync("git", ["check-ignore", "-q", dir], { cwd: ROOT }).status).toBe(0)
		const lint = spawnSync("bun", ["run", "lint"], { cwd: ROOT, encoding: "utf8" })
		expect(lint.stdout + lint.stderr).not.toContain(".e2e-")
		expect(execFileSync("git", ["status", "--porcelain", "--", dir], { cwd: ROOT, encoding: "utf8" })).toBe("")
	})

	it("the next run sweeps apps older than any e2e run and keeps a live run's", () => {
		const stale = leftover(STALE_MS + 60_000)
		const live = leftover(0)
		sweep()
		expect(existsSync(stale)).toBe(false)
		expect(existsSync(live)).toBe(true)
	})
})
