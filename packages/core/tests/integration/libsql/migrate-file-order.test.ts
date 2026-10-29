/**
 * S3 of the 0.15.0 review, on a real SQLite file: `--file` with a file of the migrations directory
 * applied it ahead of an earlier pending file, and every whole-directory run then refused the
 * directory as out of order. A file of the directory waits for the files before it; one outside
 * the directory, which no order covers, stays the escape hatch.
 */
import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type MigrateProject, migrateCli, migrateProject, sqliteRows } from "../support/migrate-project.ts"

const projects: MigrateProject[] = []
afterEach(() => {
	for (const project of projects.splice(0)) project.dispose()
})

/** A project at 1_a.sql, with 2_b.sql and 3_c.sql pending */
async function atFirst() {
	const project = migrateProject({
		"1_a.sql": "CREATE TABLE a (id INTEGER PRIMARY KEY);",
		"2_b.sql": "CREATE TABLE b (id INTEGER PRIMARY KEY);",
		"3_c.sql": "CREATE TABLE c (id INTEGER PRIMARY KEY);",
	})
	projects.push(project)
	expect((await migrateCli(project.dir, ["migrate", "apply", "core", "--file", "m/1_a.sql", "--yes"])).code).toBe(0)
	return project
}

const history = (url: string) => sqliteRows(url, "SELECT name FROM __drizzle_migrations ORDER BY id")

describe("migrate --file with a file of the migrations directory", () => {
	it("refuses a file while one before it is pending, and leaves the directory in order", async () => {
		const { dir, url } = await atFirst()
		const run = await migrateCli(dir, ["migrate", "apply", "core", "--file", "m/3_c.sql", "--yes"])
		expect(run.code).toBe(1)
		expect(run.errors.join("\n")).toContain(
			"2_b.sql is pending and sorts before 3_c.sql; apply 2_b.sql first, or run without --file",
		)
		expect(await history(url)).toEqual([["1_a.sql"]])
		expect((await migrateCli(dir, ["migrate", "check", "core"])).code).toBe(0)
	})

	it("applies the next pending file, and a file outside the directory whatever is pending", async () => {
		const { dir, url } = await atFirst()
		expect((await migrateCli(dir, ["migrate", "apply", "core", "--file", "m/2_b.sql", "--yes"])).code).toBe(0)
		fs.writeFileSync(path.join(dir, "lone.sql"), "CREATE TABLE lone (id INTEGER PRIMARY KEY);")
		expect((await migrateCli(dir, ["migrate", "apply", "core", "--file", "lone.sql", "--yes"])).code).toBe(0)
		expect(await history(url)).toEqual([["1_a.sql"], ["2_b.sql"], ["../lone.sql"]])
		expect((await migrateCli(dir, ["migrate", "apply", "core", "--yes"])).code).toBe(0)
	})
})
