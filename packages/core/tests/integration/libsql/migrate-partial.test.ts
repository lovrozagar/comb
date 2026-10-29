/**
 * S2 of the 0.15.0 review, on a real SQLite file: when a file fails after earlier files of the run
 * committed, the report names the files that landed and the ones still pending, as D1's does.
 */
import { afterEach, describe, expect, it } from "vitest"
import { type MigrateProject, migrateCli, migrateProject, sqliteRows } from "../support/migrate-project.ts"

const projects: MigrateProject[] = []
afterEach(() => {
	for (const project of projects.splice(0)) project.dispose()
})

/** A project at 1_init.sql whose post table holds two equal bodies, which 3_uniq.sql's index refuses */
async function halfway() {
	const project = migrateProject({
		"1_init.sql": "CREATE TABLE post (id INTEGER PRIMARY KEY, body TEXT);",
		"2_col.sql": "ALTER TABLE post ADD COLUMN extra TEXT;",
		"3_uniq.sql": "CREATE UNIQUE INDEX post_body ON post (body);",
		"4_tag.sql": "CREATE TABLE tag (id INTEGER PRIMARY KEY);",
	})
	projects.push(project)
	expect((await migrateCli(project.dir, ["migrate", "apply", "core", "--file", "m/1_init.sql", "--yes"])).code).toBe(0)
	await sqliteRows(project.url, "INSERT INTO post (body) VALUES ('dup'), ('dup')")
	return project
}

describe("migrate apply on SQLite, failing after a file of the run committed", () => {
	it("reports the files applied before the failure and the ones pending in --json", async () => {
		const { dir, url } = await halfway()
		const run = await migrateCli(dir, ["migrate", "apply", "core", "--yes", "--json"])
		expect(run.code).toBe(1)
		const report = JSON.parse(run.outputs.join("")) as Record<string, unknown>
		expect(report).toMatchObject({ applied: ["2_col.sql"], pending: ["3_uniq.sql", "4_tag.sql"] })
		expect(report["refused"]).toEqual([expect.stringContaining("UNIQUE constraint failed: post.body")])
		expect(await sqliteRows(url, "SELECT name FROM __drizzle_migrations ORDER BY id")).toEqual([
			["1_init.sql"],
			["2_col.sql"],
		])
	})

	it("says which files were applied before the failure", async () => {
		const { dir } = await halfway()
		const run = await migrateCli(dir, ["migrate", "apply", "core", "--yes"])
		expect(run.code).toBe(1)
		expect(run.outputs).toContain("Applied before the failure: 2_col.sql")
	})
})
