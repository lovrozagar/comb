import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { writeFindings } from "./classify-write.ts"

const pg = (sql: string) => classifyMigration(sql, { dialect: "postgres" })

describe("writeFindings", () => {
	it("rates each write at every depth, its own first", () => {
		expect(writeFindings("WITH d AS (DELETE FROM a RETURNING *) UPDATE b SET x = 1 WHERE id = 2")).toEqual([
			{ level: "cautious" },
			{ level: "unsafe" },
		])
		expect(writeFindings("SELECT 1")).toEqual([])
	})
})

/* the write bypasses of the 0.7.0 review (classify-probe.ts): a write hidden in a CTE or a subquery, or filtered by a tautology */
describe("classifyMigration on a write that hid", () => {
	it.each([
		["WITH d AS (DELETE FROM users RETURNING *) INSERT INTO archive SELECT * FROM d;", "a CTE DELETE"],
		["WITH u AS (UPDATE users SET email = NULL RETURNING id) SELECT count(*) FROM u;", "a CTE UPDATE"],
		["WITH a AS (WITH b AS (DELETE FROM users RETURNING *) SELECT * FROM b) SELECT * FROM a;", "a nested CTE"],
		[
			"INSERT INTO archive SELECT * FROM (WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d) s;",
			"a subquery CTE",
		],
		[
			"WITH m AS (MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE RETURNING *) SELECT * FROM m;",
			"a CTE MERGE",
		],
		['DELETE FROM "where";', "a table named where"],
		["DELETE FROM users WHERE true;", "WHERE true"],
		["DELETE FROM users WHERE 1=1;", "WHERE 1=1"],
		["UPDATE users SET a = 1 WHERE id = id;", "WHERE id = id"],
		["DELETE FROM users WHERE (true);", "WHERE (true)"],
		["DELETE FROM users WHERE id = 5 OR 1 = 1;", "a tautology disjunct"],
		["UPDATE users SET a = 1 WHERE NOT false;", "WHERE NOT false"],
	])("calls %j unsafe (%s)", (sql) => {
		expect(pg(sql).safety).toBe("unsafe")
	})

	it.each([
		"WITH d AS (SELECT 1) INSERT INTO t SELECT * FROM d",
		"INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 1",
		"CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\nCREATE TRIGGER t AFTER INSERT ON post FOR EACH ROW EXECUTE FUNCTION f();",
		"CREATE FUNCTION f() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;\nCREATE POLICY p ON post USING (f());",
	])("keeps %j safe", (sql) => {
		expect(pg(sql).safety).toBe("safe")
	})

	it("keeps a write filtered through a subquery cautious", () => {
		expect(pg("UPDATE post SET a = 1 WHERE id IN (SELECT id FROM gone)").safety).toBe("cautious")
	})

	it("reads the WHERE of a write up to its RETURNING", () => {
		expect(pg("DELETE FROM users WHERE id = 1 RETURNING *").safety).toBe("cautious")
		expect(pg("DELETE FROM users WHERE true RETURNING id").safety).toBe("unsafe")
	})
})
