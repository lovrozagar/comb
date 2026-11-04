import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { diffProject as diffProjectIn, fakeAtlas } from "./__fixtures__/diff.ts"
import { makeIo, projects, runCliWithFakes } from "./__fixtures__/io.ts"

const temp = projects()
const project = temp.make
afterEach(temp.clean)
const diffProject = () => diffProjectIn(project)

describe("comb migrate diff --dry-run", () => {
	it("writes nothing: exit 0 in sync, exit 1 printing the SQL a diff would write", async () => {
		const dir = diffProject()
		const run = fakeAtlas((replayed) =>
			writeFileSync(join(replayed, "20260101000000_init.sql"), "CREATE TABLE post (id TEXT PRIMARY KEY);\n"),
		)
		const drift = makeIo(dir, run)
		expect(await runCliWithFakes(["migrate", "diff", "core", "--dry-run"], drift)).toBe(1)
		expect(drift.outputs).toEqual(["-- 20260101000000_init.sql", "CREATE TABLE post (id TEXT PRIMARY KEY);\n"])
		expect(drift.errors).toEqual([
			"core has drifted from its migrations: comb migrate diff core would write the SQL above",
		])
		expect(readdirSync(dir)).toEqual(["drizzle.config.ts"])
		mkdirSync(join(dir, "atlas-migrations"))
		writeFileSync(join(dir, "atlas-migrations", "1_init.sql"), "SELECT 1;\n")
		const synced = makeIo(
			dir,
			fakeAtlas(() => undefined),
		)
		expect(await runCliWithFakes(["migrate", "diff", "core", "--dry-run"], synced)).toBe(0)
		expect(synced.outputs).toEqual(["Schema is already in sync — no migration needed"])
		expect(readdirSync(join(dir, "atlas-migrations"))).toEqual(["1_init.sql"])
	})

	/* KC2 of r22b: 0.20 diffed a new ./atlas-migrations against no history, whatever comb.migrate.config.ts said */
	it("refuses no database named, with its usage, writing nothing", async () => {
		const dir = diffProject()
		const run = fakeAtlas((replayed) => writeFileSync(join(replayed, "20260101000000_x.sql"), "SELECT 1;\n"))
		const io = makeIo(dir, run)
		expect(await runCliWithFakes(["migrate", "diff", "--dry-run"], io)).toBe(1)
		expect(io.errors).toEqual(["Usage: comb migrate diff <database> [name] [-e <name>] [--dry-run]"])
		expect({ calls: run.calls, files: readdirSync(dir) }).toEqual({ calls: [], files: ["drizzle.config.ts"] })
	})

	it("diffs an empty copy when there is no migrations directory", async () => {
		const dir = diffProject()
		const run = fakeAtlas((replayed) => writeFileSync(join(replayed, "20260101000000_x.sql"), "SELECT 1;\n"))
		const io = makeIo(dir, run)
		expect(await runCliWithFakes(["migrate", "diff", "core", "--dry-run"], io)).toBe(1)
		expect(io.errors).toEqual([
			"core has drifted from its migrations: comb migrate diff core would write the SQL above",
		])
		expect(readdirSync(dir)).toEqual(["drizzle.config.ts"])
	})

	it("says when the schema is already in sync", async () => {
		const io = makeIo(
			diffProject(),
			fakeAtlas(() => undefined),
		)
		expect(await runCliWithFakes(["migrate", "diff", "core"], io)).toBe(0)
		expect(io.outputs).toEqual(["Schema is already in sync — no migration needed"])
	})
})

describe("comb migrate diff: its migrations dir", () => {
	/* D2-7 of the area D round-two review: a file there fell through to ENOTDIR after drizzle-kit and Atlas ran */
	it("refuses a migrations dir that is a file before anything runs, as the other commands do", async () => {
		const dir = diffProject()
		writeFileSync(join(dir, "atlas-migrations"), "SELECT 1;\n")
		for (const argv of [
			["migrate", "diff", "core"],
			["migrate", "diff", "core", "--dry-run"],
		]) {
			const run = fakeAtlas(() => undefined)
			const io = makeIo(dir, run)
			expect(await runCliWithFakes(argv, io)).toBe(1)
			expect({ calls: run.calls, errors: io.errors }).toEqual({
				calls: [],
				errors: [`Migrations dir ${join(dir, "atlas-migrations")} is not a directory`],
			})
		}
	})

	it("removes its copy when copying the migrations dir fails", async () => {
		const dir = diffProject()
		mkdirSync(join(dir, "atlas-migrations"))
		writeFileSync(join(dir, "atlas-migrations", "1_init.sql"), "SELECT 1;\n")
		chmodSync(join(dir, "atlas-migrations", "1_init.sql"), 0o000)
		const tmp = project()
		vi.stubEnv("TMPDIR", tmp)
		try {
			const io = makeIo(
				dir,
				fakeAtlas(() => undefined),
			)
			expect(await runCliWithFakes(["migrate", "diff", "core", "--dry-run"], io)).toBe(1)
			expect(io.errors.join("\n")).toContain("EACCES")
			expect(readdirSync(tmp)).toEqual([])
		} finally {
			vi.unstubAllEnvs()
			chmodSync(join(dir, "atlas-migrations", "1_init.sql"), 0o644)
		}
	})
})
