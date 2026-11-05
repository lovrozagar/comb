/**
 * On a real SQLite file: `ALTER TABLE "users"DROP COLUMN email` drops the column as the spelling with
 * a space does. comb's reading rated it safe, and only the proof run's loss stood between it and a
 * table the proof cannot seed; check and apply now refuse the statement itself, and the column stays.
 */
import { afterEach, describe, expect, it } from "vitest"
import { type MigrateProject, migrateCli, migrateProject, sqliteRows } from "../support/migrate-project.ts"

const projects: MigrateProject[] = []
afterEach(() => {
	for (const project of projects.splice(0)) project.dispose()
})

describe("migrate check and apply on a DROP COLUMN written against its quoted table", () => {
	it("refuses it as unsafe, so the column keeps its values", async () => {
		const project = migrateProject({
			"1_init.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);",
			"2_drop.sql": 'ALTER TABLE "users"DROP COLUMN email;\n',
		})
		projects.push(project)
		const { dir, url } = project
		expect((await migrateCli(dir, ["migrate", "apply", "core", "--file", "m/1_init.sql", "--yes"])).code).toBe(0)
		await sqliteRows(url, "INSERT INTO users (email) VALUES ('a@b.c')")
		const check = await migrateCli(dir, ["migrate", "check", "core"])
		expect(check.code).toBe(1)
		expect(check.errors.join("\n")).toContain(
			'2_drop.sql is unsafe (ALTER TABLE "users"DROP COLUMN email; proof run: loses',
		)
		const apply = await migrateCli(dir, ["migrate", "apply", "core", "--yes"])
		expect(apply.code).toBe(1)
		expect(apply.errors.join("\n")).toContain('(ALTER TABLE "users"DROP COLUMN email; proof run: loses')
		expect(await sqliteRows(url, "SELECT email FROM users")).toEqual([["a@b.c"]])
	})
})
