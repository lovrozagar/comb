import { describe, expect, it } from "vitest"
import type { ExtractedSchema } from "../types.ts"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const pg = (sql: string) => classifyMigration(sql, { dialect: "postgres" })
const lite = (sql: string, before?: ExtractedSchema) => classifyMigration(sql, { before, dialect: "sqlite" })

describe("classifyMigration on a statement that runs only outside a transaction", () => {
	it.each([
		"CREATE INDEX CONCURRENTLY i ON post (a)",
		"-- atlas:txmode none\nCREATE INDEX CONCURRENTLY i ON post (a);",
		"DROP INDEX CONCURRENTLY i",
		"REINDEX TABLE CONCURRENTLY post",
		"VACUUM post",
		"-- comb:allow-unsafe: maintenance\nVACUUM post",
	])("refuses %j outside an -- atlas:txmode none file, whatever the approval", (sql) => {
		expect(() => pg(sql)).toThrow(/-- atlas:txmode none/)
	})

	it("accepts each of them in an -- atlas:txmode none file, and refuses VACUUM on SQLite", () => {
		expect(pg("-- atlas:txmode none\n\nVACUUM post;\nDROP INDEX CONCURRENTLY i;").safety).toBe("cautious")
		expect(() => lite("VACUUM")).toThrow("VACUUM")
	})
})

describe("classifyMigration on comb's FTS regroup", () => {
	it("calls the drop of an external-content FTS index cautious when the file creates it again and rebuilds it", () => {
		const regroup = `DROP TRIGGER IF EXISTS post_fts_ai;
DROP TABLE IF EXISTS post_fts;
CREATE VIRTUAL TABLE IF NOT EXISTS post_fts USING fts5(title, content='post', content_rowid='id');
INSERT INTO post_fts(post_fts) VALUES ('rebuild');`
		const external = extractSchema(
			"CREATE VIRTUAL TABLE post_fts USING fts5(title, content='post', content_rowid='id');",
		)
		expect(lite(regroup, external).safety).toBe("cautious")
		expect(lite(regroup.replace("content='post', ", ""), external).safety).toBe("unsafe")
		expect(lite(regroup.replace(/INSERT INTO[^\n]*/, "")).safety).toBe("unsafe")
		expect(lite("DROP TABLE IF EXISTS post_fts, post;\n" + regroup.split("\n").slice(2).join("\n")).safety).toBe(
			"unsafe",
		)
	})
})

describe("classifyMigration on a drop of an FTS5 table that stored its own text (M8)", () => {
	it("rates it unsafe though the file recreates it as an external-content index of an empty table", () => {
		const stored = extractSchema(
			"CREATE TABLE src (id integer PRIMARY KEY, body text);\nCREATE VIRTUAL TABLE notes USING fts5(body);",
		)
		const replaced = `DROP TABLE notes;
CREATE VIRTUAL TABLE notes USING fts5(body, content='src', content_rowid='id');
INSERT INTO notes(notes) VALUES ('rebuild');`
		expect(lite(replaced, stored).safety).toBe("unsafe")
		expect(lite(replaced).safety).toBe("unsafe")
		const contentless = extractSchema("CREATE VIRTUAL TABLE notes USING fts5(body, content='');")
		expect(contentless.externalFts).toEqual(["notes"])
		expect(lite(replaced, contentless).safety).toBe("cautious")
	})
})

describe("classifyMigration on a SQLite pragma", () => {
	it.each([
		["PRAGMA writable_schema = 1;", "unsafe"],
		["PRAGMA ignore_check_constraints = on;", "cautious"],
		["PRAGMA foreign_keys = off;", "cautious"],
		["PRAGMA defer_foreign_keys = on;", "safe"],
	])("rates %j %s, as only defer_foreign_keys is a pragma comb writes", (sql, safety) => {
		expect(lite(sql).safety).toBe(safety)
	})
})
