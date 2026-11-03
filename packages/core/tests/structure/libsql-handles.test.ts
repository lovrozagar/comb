/**
 * SL1 of r22: a libsql file's per-file connections let go of the database when their files end.
 * This applies files in this process and counts its open descriptors on the database, its journal
 * and its WAL (Linux's /proc/self/fd). The command's own reader and writer hold the file until
 * garbage collection frees the statements @libsql/client prepared on them (5.6-probe-gc.log), at
 * most one each; the per-file connections, on libsql's Database through exec alone, hold nothing,
 * so what is left does not grow with the files.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { migrateCli, migrateProject } from "../integration/support/migrate-project.ts"

/** This process's descriptors open on the database at `file` or a file beside it of its name */
function openOn(file: string): number {
	return fs
		.readdirSync("/proc/self/fd")
		.map((fd) => {
			try {
				return fs.readlinkSync(path.join("/proc/self/fd", fd))
			} catch {
				// reason: the descriptor readdir itself held, or one closed since, links nowhere
				return ""
			}
		})
		.filter((target) => target.startsWith(file)).length
}

/** The descriptors left on its database after a fresh project of `count` files applies */
async function leftAfter(count: number): Promise<number> {
	const files = Object.fromEntries(
		Array.from({ length: count }, (_, at) => [
			`${String(at + 1).padStart(4, "0")}_c.sql`,
			`CREATE TABLE c${at + 1} (x INTEGER);\nINSERT INTO c${at + 1} (x) VALUES (${at});\n`,
		]),
	)
	const project = migrateProject(files)
	try {
		const run = await migrateCli(project.dir, ["migrate", "apply", "core", "--yes"])
		expect(run.code, run.errors.join("\n")).toBe(0)
		expect(run.outputs).toContain(`\nDone: ${count} applied, 0 skipped`)
		return openOn(path.join(project.dir, "local.db"))
	} finally {
		project.dispose()
	}
}

describe("a libsql apply's descriptors do not grow with its files (SL1 of r22; sibling: the 300-file apply under ulimit)", () => {
	it("leaves as many open after 12 files as after 1, the command's reader and writer at most", async () => {
		const one = await leftAfter(1)
		expect(one).toBeLessThanOrEqual(2)
		expect(await leftAfter(12)).toBe(one)
	}, 60_000)
})
