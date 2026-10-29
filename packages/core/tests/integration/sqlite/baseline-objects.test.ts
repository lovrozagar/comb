/**
 * N-S5 of plan 15's rerun: a SQLite baseline on real Atlas. Atlas OSS refuses a trigger or view
 * ("triggers are available to logged-in users only"), so comb hands it the tables and indexes of
 * both sides alone and compares the triggers, views and FTS tables itself (S5): a database whose
 * trigger and view are the history's is in sync, and one whose view differs is named.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { libsqlConnection } from "../../../src/migrate/__fixtures__/libsql-connection.ts"
import { sqliteDrift } from "../../../src/migrate/core/baseline-compare.ts"
import { run } from "../../../src/migrate/core/process.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-baseline-objects-"))
	mkdirSync(join(dir, "m"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const TABLE = "CREATE TABLE post (id TEXT PRIMARY KEY, title TEXT);\nCREATE INDEX post_title ON post (title);\n"
const TRIGGER = "CREATE TRIGGER post_audit AFTER INSERT ON post BEGIN SELECT 1; END;\n"
const VIEW = "CREATE VIEW recent AS SELECT id FROM post;\n"

describe("a SQLite baseline's drift, on Atlas OSS", () => {
	it("finds a database whose trigger and view are the history's in sync, one that dropped and remade them included", async () => {
		writeFileSync(join(dir, "m", "1_init.sql"), `${TABLE}${TRIGGER}${VIEW}`)
		writeFileSync(join(dir, "m", "2_again.sql"), `DROP VIEW recent;\n${VIEW}`)
		const conn = libsqlConnection()
		await conn.client.executeMultiple(`${TABLE}${TRIGGER}${VIEW}`)
		expect(await sqliteDrift(conn, join(dir, "m"), run)).toBe("")
	}, 60_000)

	it("names a view whose definition differs, and a table Atlas finds apart", async () => {
		writeFileSync(join(dir, "m", "1_init.sql"), `${TABLE}${TRIGGER}${VIEW}`)
		const conn = libsqlConnection()
		await conn.client.executeMultiple(
			`${TABLE}ALTER TABLE post ADD COLUMN body TEXT;\n${TRIGGER}CREATE VIEW recent AS SELECT id, title FROM post;\n`,
		)
		const drift = await sqliteDrift(conn, join(dir, "m"), run)
		expect(drift).toContain("-- view recent: the database has")
		/* Atlas brings the database's post to the history's by rebuilding it without body */
		expect(drift).toContain("CREATE TABLE `new_post`")
	}, 60_000)
})
