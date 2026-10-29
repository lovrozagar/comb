/**
 * S1 of the 0.15.0 review, on a real SQLite file: a COMMIT inside a migration ended the batch that
 * applies and records the file, so a failure after it committed half the file with no history
 * row, and each later apply ran that half again. check and apply refuse the file before any of it runs.
 */
import { afterEach, describe, expect, it } from "vitest"
import { type MigrateProject, migrateCli, migrateProject, sqliteRows } from "../support/migrate-project.ts"

const projects: MigrateProject[] = []
afterEach(() => {
	for (const project of projects.splice(0)) project.dispose()
})

describe("migrate check and apply on a file holding a COMMIT", () => {
	it("refuses the file, so a failure after its COMMIT never commits half of it", async () => {
		const project = migrateProject({
			"1_init.sql": "CREATE TABLE post (id INTEGER PRIMARY KEY, body TEXT);",
			"2_x.sql":
				"INSERT INTO post (body) VALUES ('x');\nCOMMIT;\nBEGIN;\nCREATE UNIQUE INDEX post_body ON post (body);\n",
		})
		projects.push(project)
		const { dir, url } = project
		expect((await migrateCli(dir, ["migrate", "apply", "core", "--file", "m/1_init.sql", "--yes"])).code).toBe(0)
		await sqliteRows(url, "INSERT INTO post (body) VALUES ('dup'), ('dup')")
		const check = await migrateCli(dir, ["migrate", "check", "core"])
		expect(check.code).toBe(1)
		expect(check.errors.join("\n")).toContain("comb runs each file in a transaction of its own")
		for (const _ of [1, 2]) expect((await migrateCli(dir, ["migrate", "apply", "core", "--yes"])).code).toBe(1)
		expect(await sqliteRows(url, "SELECT count(*) FROM post WHERE body = 'x'")).toEqual([[0]])
		expect(await sqliteRows(url, "SELECT count(*) FROM __drizzle_migrations")).toEqual([[1]])
	})
})
