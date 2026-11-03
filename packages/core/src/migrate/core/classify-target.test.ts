import { describe, expect, it } from "vitest"
import { targetRefusal } from "./classify-target.ts"
import { codeOf, pragmaOf } from "./sql-code.ts"

/** targetRefusal of `sql` as the gate reads it */
const refusal = (sql: string, kind: "d1" | "local" | "sqld") => {
	const code = codeOf(sql, "sqlite")
	return targetRefusal(code, pragmaOf(code), kind)
}

describe("targetRefusal by target kind (S1 of r22; sibling: D1's list, r19 S1)", () => {
	it.each([
		["PRAGMA legacy_alter_table = ON", /legacy_alter_table with a value/],
		["PRAGMA optimize", /a read of optimize/],
		['PRAGMA "foreign_keys" = 1', /a pragma whose name is quoted/],
		["ANALYZE", /refuses ANALYZE/],
		["attach 'x.db' as x", /refuses ATTACH/],
		["CREATE TEMP TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END", /a TEMP object/],
		["CREATE TABLE IF NOT EXISTS temp.t (a)", /a table in temp/],
		["SELECT load_extension('x')", /load_extension\(\)/],
	])("names what the libsql server (sqld) refuses in %j", (sql, what) => {
		expect(refusal(sql, "sqld")).toMatch(/^the libsql server \(sqld\) behind this database, Turso's included/)
		expect(refusal(sql, "sqld")).toMatch(what)
	})

	it.each([
		"PRAGMA foreign_keys = ON",
		"PRAGMA journal_mode",
		"CREATE INDEX i ON t (a)",
		"CREATE VIEW temp.v AS SELECT 1",
	])("lets %j, which sqld parses, through on sqld", (sql) => {
		expect(refusal(sql, "sqld")).toBeUndefined()
	})

	it.each([
		["PRAGMA cache_size = 10", true],
		["PRAGMA page_size = 4096", true],
		["PRAGMA page_size", false],
		["PRAGMA recursive_triggers = 1", false],
		["ANALYZE", false],
	] as const)("holds %j on D1 to its authorizer's list", (sql, refused) => {
		expect(refusal(sql, "d1") !== undefined).toBe(refused)
	})

	it.each(["PRAGMA cache_size = 10", "ANALYZE", "ATTACH 'x.db' AS x", "CREATE TEMP TABLE t (a)"])(
		"refuses nothing of %j on a local file, whose own SQLite decides",
		(sql) => {
			expect(refusal(sql, "local")).toBeUndefined()
		},
	)
})
