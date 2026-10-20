/**
 * Incremental migrations for a schema with FTS5 tables, on the real Atlas binary. Atlas's dev
 * database has no fts5 module, so comb replays history and diffs the target without FTS, then
 * writes the FTS delta itself. Every migration produced here is then run on SQLite.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it } from "vitest"
import { generateIncrementalMigration } from "../../../src/migrate/core/atlas.ts"
import { describeAtlas } from "../support/atlas.ts"
import { libsqlMemory } from "../support/libsql.ts"

/** The FTS DDL the fts generator writes for `table` over `columns` */
function ftsFor(table: string, columns: string[]): string {
	const list = columns.join(", ")
	const fts = `${table}_fts`
	return `CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(
	${list},
	content='${table}',
	content_rowid='rowid',
	tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS ${fts}_ai AFTER INSERT ON ${table} BEGIN
	INSERT INTO ${fts}(rowid, ${list}) VALUES (new.rowid, ${columns.map((c) => `new.${c}`).join(", ")});
END;

CREATE TRIGGER IF NOT EXISTS ${fts}_ad AFTER DELETE ON ${table} BEGIN
	INSERT INTO ${fts}(${fts}, rowid, ${list}) VALUES ('delete', old.rowid, ${columns.map((c) => `old.${c}`).join(", ")});
END;
`
}

const ITEMS = "CREATE TABLE `items` (`id` integer NOT NULL PRIMARY KEY, `name` text NOT NULL, `body` text);"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

/** A migrations directory whose first migration created `items` and its FTS over `columns` */
function history(columns: string[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-atlas-fts-"))
	dirs.push(dir)
	fs.writeFileSync(path.join(dir, "20260101000000_init.sql"), `${ITEMS}\n${ftsFor("items", columns)}`)
	return dir
}

/** Every migration in `dir` run in order on a fresh SQLite, then rows inserted and searched */
async function search(dir: string, term: string): Promise<string[]> {
	const harness = libsqlMemory()
	try {
		for (const file of fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".sql"))
			.sort()) {
			await harness.client.executeMultiple(fs.readFileSync(path.join(dir, file), "utf8"))
		}
		await harness.client.execute(
			"INSERT INTO items (id, name, body) VALUES (1, 'kettle', 'boils water'), (2, 'lamp', 'gives light')",
		)
		const { rows } = await harness.client.execute({
			args: [term],
			sql: "SELECT rowid FROM items_fts WHERE items_fts MATCH ? ORDER BY rowid",
		})
		return rows.map((row) => String(row[0]))
	} finally {
		harness.close()
	}
}

describeAtlas("atlas migrate diff with FTS5 tables (S-12)", () => {
	it("diffs a plain change on a history that holds FTS, and the FTS still works after it", async () => {
		const dir = history(["name"])
		const result = generateIncrementalMigration({
			dialect: "sqlite",
			ftsSql: ftsFor("items", ["name"]),
			migrationName: "add_flag",
			migrationsDir: dir,
			targetSchema: ITEMS.replace("`body` text", "`body` text, `flag` integer"),
		})
		expect(result.synced).toBe(false)
		expect(fs.readFileSync(result.files[0] as string, "utf8")).toMatch(/ADD COLUMN `flag`/)
		expect(await search(dir, "kettle")).toEqual(["1"])
	})

	it("writes the FTS delta itself when the FTS definition changes: drop, create, rebuild", async () => {
		const dir = history(["name"])
		const result = generateIncrementalMigration({
			dialect: "sqlite",
			ftsSql: ftsFor("items", ["name", "body"]),
			migrationName: "fts_body",
			migrationsDir: dir,
			targetSchema: ITEMS,
		})
		expect(result.synced).toBe(false)
		const sql = fs.readFileSync(result.files[0] as string, "utf8")
		expect(sql).toMatch(/DROP TABLE IF EXISTS "items_fts"/)
		expect(sql).toMatch(/INSERT INTO "items_fts"\("items_fts"\) VALUES \('rebuild'\)/)
		expect(await search(dir, "light")).toEqual(["2"])
	})

	it("reports synced when neither the tables nor the FTS changed", () => {
		const dir = history(["name"])
		const result = generateIncrementalMigration({
			dialect: "sqlite",
			ftsSql: ftsFor("items", ["name"]),
			migrationName: "noop",
			migrationsDir: dir,
			targetSchema: ITEMS,
		})
		expect(result).toEqual({ files: [], synced: true })
	})

	it("recreates the FTS triggers when Atlas rewrites their content table", async () => {
		const dir = history(["name"])
		/* dropping NOT NULL makes Atlas rebuild items, which drops the triggers on it */
		const result = generateIncrementalMigration({
			dialect: "sqlite",
			ftsSql: ftsFor("items", ["name"]),
			migrationName: "relax_name",
			migrationsDir: dir,
			targetSchema: ITEMS.replace("`name` text NOT NULL", "`name` text"),
		})
		expect(result.synced).toBe(false)
		expect(await search(dir, "lamp")).toEqual(["2"])
	})
})
