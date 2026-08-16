import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { applySqliteMigrationTransforms } from "../../src/migrate/core/atlas.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   applySqliteMigrationTransforms

   Runs under `bun test` (NOT vitest) because it imports `bun:sqlite` for the
   integration replay. Vitest excludes `tests/bun/**` per vitest.config.ts.
   ═══════════════════════════════════════════════════════════════════════════ */

/* An Atlas-shaped drift migration: table rebuilds (create `new_*`, copy rows,
   drop, rename), an ADD COLUMN, fresh tables, and indexes. Already stored
   post-transform, so it opens with the `defer_foreign_keys` prelude. */
const DRIFT_FIXTURE_PATH = path.resolve(import.meta.dirname, "../fixtures/atlas-drift.sql")

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

		const tableNames = (sql: string) =>
			[...sql.matchAll(/CREATE TABLE\s+`([^`]+)`/gi)].map((m: RegExpMatchArray) => m[1] ?? "").sort()
		const indexNames = (sql: string) =>
			[...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+`([^`]+)`/gi)].map((m: RegExpMatchArray) => m[1] ?? "").sort()
		const alterStmts = (sql: string) =>
			[...sql.matchAll(/^ALTER TABLE.*$/gim)].map((m: RegExpMatchArray) => m[0] ?? "").sort()

		expect(tableNames(output)).toEqual(tableNames(input))
		expect(indexNames(output)).toEqual(indexNames(input))
		expect(alterStmts(output)).toEqual(alterStmts(input))
	})

	it("drift migration replays cleanly in bun:sqlite with FK enforcement after commit", () => {
		const driftSql = fs.readFileSync(DRIFT_FIXTURE_PATH, "utf-8")
		const transformed = applySqliteMigrationTransforms(driftSql)

		const db = new Database(":memory:")

		/* Seed prerequisite tables that earlier migrations would have left
		   behind — the drift file references these via FKs / copy-rows. */
		db.exec(`
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
		`)

		const wrapped = `BEGIN;\n${transformed}\nCOMMIT;`
		expect(() => db.exec(wrapped)).not.toThrow()

		const tableRows = db
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all()
		const tables = tableRows.map((r: { name: string }) => r.name)
		const expected = ["author", "comment", "post", "post_tag", "post_translation", "tag"]
		for (const t of expected) {
			expect(tables).toContain(t)
		}
		/* The `new_*` scaffolding tables must not survive the rebuild. */
		expect(tables.filter((t: string) => t.startsWith("new_"))).toEqual([])

		/* Rows survived the copy step. */
		const posts = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM post").get()
		expect(posts?.n).toBe(1)
		const comments = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM comment").get()
		expect(comments?.n).toBe(1)

		/* defer_foreign_keys resets at commit; re-enable enforcement to confirm
		   the FK constraints survived the rewrite. */
		db.exec("PRAGMA foreign_keys = ON;")
		expect(() => db.exec("INSERT INTO post_tag (post_id, tag_id) VALUES ('p1', 'nonexistent');")).toThrow(
			/FOREIGN KEY constraint failed/i,
		)

		db.close()
	})
})
