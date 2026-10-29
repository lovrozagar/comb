/**
 * S5 of the 0.15.0 review, through the real wrangler --local: a refused D1 apply or baseline made
 * the local database and both history tables before it refused (on --remote, the same CREATEs
 * reached production). It now reads the history the way check does, a missing database being an
 * empty one, and writes nothing until every check has passed.
 */
import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../../src/cli/index.ts"
import { d1Column, d1Io, d1Project, wrangler } from "../support/d1-project.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

function project(migrations: Record<string, string>): string {
	const dir = d1Project(migrations)
	dirs.push(dir)
	return dir
}

const INIT = { "20260101000000_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY);" }
const tables = (dir: string) =>
	d1Column(
		dir,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
	)

describe("a refused D1 apply or baseline, the local database missing", () => {
	it("creates no local database when atlas.sum refuses the apply", async () => {
		const dir = project(INIT)
		fs.appendFileSync(path.join(dir, "atlas-migrations", "20260101000000_init.sql"), "\n-- edited")
		const out = d1Io(dir)
		expect(await runCli(["migrate", "apply", "core", "--local"], out)).toBe(1)
		expect(out.errors[0]).toContain("atlas.sum does not match its migrations")
		expect(fs.existsSync(path.join(dir, ".wrangler"))).toBe(false)
	}, 120_000)

	it("creates no local database when baseline finds no record to copy", async () => {
		const dir = project(INIT)
		const out = d1Io(dir)
		expect(await runCli(["migrate", "baseline", "core", "--local"], out)).toBe(1)
		expect(out.errors[0]).toContain("has no __drizzle_migrations to copy from")
		expect(fs.existsSync(path.join(dir, ".wrangler"))).toBe(false)
	}, 120_000)
})

describe("a refused D1 apply on a local database comb never migrated", () => {
	it("leaves both history tables unmade when approval refuses a file", async () => {
		const dir = project({ "20260101000000_drop.sql": "DROP TABLE post;" })
		expect(
			wrangler(dir)("wrangler", ["d1", "execute", "core", "--local", "--command=CREATE TABLE post (id TEXT)"]).code,
		).toBe(0)
		const out = d1Io(dir)
		expect(await runCli(["migrate", "apply", "core", "--local"], out)).toBe(1)
		expect(tables(dir)).toEqual(["post"])
	}, 120_000)

	it("makes comb's hash table with the hashes it records, once wrangler has applied", async () => {
		const dir = project(INIT)
		const out = d1Io(dir)
		expect(await runCli(["migrate", "apply", "core", "--local"], out), out.errors.join("\n")).toBe(0)
		expect(tables(dir)).toEqual(["_comb_migration_hashes", "d1_migrations", "post", "sqlite_sequence"])
		expect(d1Column(dir, "SELECT name FROM _comb_migration_hashes")).toEqual(["20260101000000_init.sql"])
	}, 120_000)
})
