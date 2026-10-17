import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { applySqliteMigrationTransforms } from "../../../src/migrate/core/atlas.ts"
import { libsqlMemory } from "../support/libsql.ts"

/* An Atlas-shaped drift migration: table rebuilds (create `new_*`, copy rows,
   drop, rename), an ADD COLUMN, fresh tables, and indexes. Already stored
   post-transform, so it opens with the `defer_foreign_keys` prelude. */
const DRIFT_FIXTURE_PATH = path.resolve(import.meta.dirname, "../../../src/migrate/__fixtures__/atlas-drift.sql")

/* Tables that earlier migrations would have left behind; the drift file references these via FKs / copy-rows. */
const SEED = `
	CREATE TABLE author (id TEXT PRIMARY KEY);
	CREATE TABLE post (
		id TEXT PRIMARY KEY,
		author_id TEXT,
		slug TEXT,
		title TEXT,
		status TEXT,
		published_at INTEGER,
		created_at INTEGER,
		updated_at INTEGER,
		deleted_at INTEGER
	);
	CREATE TABLE comment (
		id TEXT PRIMARY KEY,
		post_id TEXT,
		body TEXT,
		created_at INTEGER
	);
	INSERT INTO author (id) VALUES ('a1');
	INSERT INTO post (id, author_id, slug, title, status, created_at, updated_at)
		VALUES ('p1', 'a1', 'first-post', 'First post', 'published', 1, 1);
	INSERT INTO comment (id, post_id, body, created_at) VALUES ('c1', 'p1', 'hi', 1);
`

const tableNames = (sql: string) =>
	[...sql.matchAll(/CREATE TABLE\s+`([^`]+)`/gi)].map((m: RegExpMatchArray) => m[1] ?? "").sort()
const indexNames = (sql: string) =>
	[...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+`([^`]+)`/gi)].map((m: RegExpMatchArray) => m[1] ?? "").sort()
const alterStmts = (sql: string) =>
	[...sql.matchAll(/^ALTER TABLE.*$/gim)].map((m: RegExpMatchArray) => m[0] ?? "").sort()

describe("applySqliteMigrationTransforms", () => {
	it("swaps foreign_keys off pair for defer_foreign_keys prelude", () => {
		const input = [
			"-- Disable the enforcement of foreign-keys constraints",
			"PRAGMA foreign_keys = off;",
			"CREATE TABLE x (id TEXT PRIMARY KEY);",
			"-- Enable back the enforcement of foreign-keys constraints",
			"PRAGMA foreign_keys = on;",
			"",
		].join("\n")

		const out = applySqliteMigrationTransforms(input)

		const firstMeaningful = out
			.split("\n")
			.map((l: string) => l.trim())
			.find((l: string) => l.length > 0 && !l.startsWith("--"))
		expect(firstMeaningful).toBe("PRAGMA defer_foreign_keys = on;")

		expect(out.toLowerCase()).not.toContain("pragma foreign_keys = off")
		expect(out.toLowerCase()).not.toContain("pragma foreign_keys = on")
		expect(out).toContain("CREATE TABLE x (id TEXT PRIMARY KEY);")
	})

	it("idempotent — re-running on transformed output yields same result", () => {
		const input = [
			"-- Disable the enforcement of foreign-keys constraints",
			"PRAGMA foreign_keys = off;",
			"CREATE TABLE x (id TEXT PRIMARY KEY);",
			"-- Enable back the enforcement of foreign-keys constraints",
			"PRAGMA foreign_keys = on;",
			"",
		].join("\n")

		const once = applySqliteMigrationTransforms(input)
		const twice = applySqliteMigrationTransforms(once)
		expect(twice).toBe(once)
	})
})

describe("applySqliteMigrationTransforms: partial input", () => {
	it("pass-through when no foreign_keys pragma present", () => {
		const input = ["CREATE TABLE users (id TEXT PRIMARY KEY);", "CREATE INDEX idx_users_id ON users (id);", ""].join(
			"\n",
		)

		const out = applySqliteMigrationTransforms(input)
		expect(out).toBe(input)
	})

	it("strips closing pragma even when comment is missing", () => {
		const input = ["PRAGMA foreign_keys = off;", "CREATE TABLE x (id TEXT);", "PRAGMA foreign_keys = on;", ""].join(
			"\n",
		)

		const out = applySqliteMigrationTransforms(input)

		const firstMeaningful = out
			.split("\n")
			.map((l: string) => l.trim())
			.find((l: string) => l.length > 0 && !l.startsWith("--"))
		expect(firstMeaningful).toBe("PRAGMA defer_foreign_keys = on;")

		expect(out).toContain("CREATE TABLE x (id TEXT);")
		expect(out.toLowerCase()).not.toContain("pragma foreign_keys = off")
		expect(out.toLowerCase()).not.toContain("pragma foreign_keys = on")
	})
})

describe("applySqliteMigrationTransforms on the drift fixture", () => {
	it("preserves all CREATE TABLE, ALTER TABLE, CREATE INDEX statements verbatim", () => {
		const fixture = fs.readFileSync(DRIFT_FIXTURE_PATH, "utf-8")

		/* The fixture on disk is already post-transform. Synthesize the raw Atlas
		   wrapper around its statements so we can assert the transform preserves
		   every CREATE/ALTER/INDEX verbatim. */
		const statements = fixture.replace(/^PRAGMA defer_foreign_keys = on;\n/, "")
		const input = [
			"-- Disable the enforcement of foreign-keys constraints",
			"PRAGMA foreign_keys = off;",
			statements.trimEnd(),
			"-- Enable back the enforcement of foreign-keys constraints",
			"PRAGMA foreign_keys = on;",
			"",
		].join("\n")

		/* Sanity: synthesized input must contain the bad PRAGMA we are removing. */
		expect(input).toContain("PRAGMA foreign_keys = off;")

		const output = applySqliteMigrationTransforms(input)

		expect(output.toLowerCase()).not.toContain("pragma foreign_keys = off")
		expect(output.toLowerCase()).not.toContain("pragma foreign_keys = on")
		expect(output).toContain("PRAGMA defer_foreign_keys = on;")

		expect(tableNames(output)).toEqual(tableNames(input))
		expect(indexNames(output)).toEqual(indexNames(input))
		expect(alterStmts(output)).toEqual(alterStmts(input))
	})
})

describe("applySqliteMigrationTransforms on a real SQLite", () => {
	it("drift migration replays cleanly with FK enforcement after commit", async () => {
		const transformed = applySqliteMigrationTransforms(fs.readFileSync(DRIFT_FIXTURE_PATH, "utf-8"))
		const { client, close } = libsqlMemory()
		try {
			await client.executeMultiple(SEED)
			await expect(client.executeMultiple(`BEGIN;\n${transformed}\nCOMMIT;`)).resolves.toBeUndefined()

			const tableRows = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			const tables = tableRows.rows.map((row) => String(row.name))
			for (const t of ["author", "comment", "post", "post_tag", "post_translation", "tag"]) {
				expect(tables).toContain(t)
			}
			/* The `new_*` scaffolding tables must not survive the rebuild. */
			expect(tables.filter((t) => t.startsWith("new_"))).toEqual([])

			/* Rows survived the copy step. */
			expect((await client.execute("SELECT COUNT(*) AS n FROM post")).rows[0]?.n).toBe(1)
			expect((await client.execute("SELECT COUNT(*) AS n FROM comment")).rows[0]?.n).toBe(1)

			/* defer_foreign_keys resets at commit; re-enable enforcement to confirm
			   the FK constraints survived the rewrite. */
			await client.execute("PRAGMA foreign_keys = ON")
			await expect(
				client.execute("INSERT INTO post_tag (post_id, tag_id) VALUES ('p1', 'nonexistent')"),
			).rejects.toThrow(/FOREIGN KEY constraint failed/i)
		} finally {
			close()
		}
	})
})
