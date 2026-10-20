import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"

const pg = (sql: string) => classifyMigration(sql, { dialect: "postgres" })
const lite = (sql: string) => classifyMigration(sql, { dialect: "sqlite" })

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
		expect(lite(regroup).safety).toBe("cautious")
		expect(lite(regroup.replace("content='post', ", "")).safety).toBe("unsafe")
		expect(lite(regroup.replace(/INSERT INTO[^\n]*/, "")).safety).toBe("unsafe")
		expect(lite("DROP TABLE IF EXISTS post_fts, post;\n" + regroup.split("\n").slice(2).join("\n")).safety).toBe(
			"unsafe",
		)
	})
})
