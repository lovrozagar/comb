import { describe, expect, it } from "vitest"
import { normalizeSql, segments, splitSqlStatements } from "./sql-scan.ts"

const kinds = (sql: string) => segments(sql).map(({ kind, text }) => `${kind}:${text}`)

describe("segments", () => {
	/* the last case: in brackets a doubled ] is no escape, the first ] closes */
	it.each([
		["'a;b'", ["literal:'a;b'"]],
		['"a;b"', ['literal:"a;b"']],
		["`a;b`", ["literal:`a;b`"]],
		["[a;b]", ["literal:[a;b]"]],
		["'it''s'", ["literal:'it''s'"]],
		['"say ""hi"""', ['literal:"say ""hi"""']],
		["[a]]b", ["literal:[a]", "code:]b"]],
	])("reads %s as one literal", (sql, expected) => {
		expect(kinds(sql)).toEqual(expected)
	})

	it("reads comments to their end, an unterminated one to the end of the text", () => {
		expect(kinds("a -- b\nc")).toEqual(["code:a ", "comment:-- b", "code:\nc"])
		expect(kinds("a -- b")).toEqual(["code:a ", "comment:-- b"])
		expect(kinds("a /* b */ c")).toEqual(["code:a ", "comment:/* b */", "code: c"])
		expect(kinds("a /* b")).toEqual(["code:a ", "comment:/* b"])
	})

	it("runs an unterminated literal to the end of the text", () => {
		expect(kinds("x 'open")).toEqual(["code:x ", "literal:'open"])
	})

	it("concatenates back to the input", () => {
		const sql = "SELECT 'a', \"b\" -- c\n/* d */ FROM `t` WHERE [x] = 1;"
		expect(
			segments(sql)
				.map(({ text }) => text)
				.join(""),
		).toBe(sql)
	})
})

describe("splitSqlStatements", () => {
	it.each([
		["SELECT 1; SELECT 2", ["SELECT 1", "SELECT 2"]],
		["SELECT 1;;  ;\nSELECT 2;", ["SELECT 1", "SELECT 2"]],
		["-- only a comment\n/* and another */", []],
		["", []],
		["SELECT ';' AS a", ["SELECT ';' AS a"]],
		["BEGIN TRANSACTION; SELECT 1; END;", ["BEGIN TRANSACTION", "SELECT 1", "END"]],
		[
			"CREATE TEMP TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END; SELECT 2",
			["CREATE TEMP TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END", "SELECT 2"],
		],
		[
			"CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET v = CASE WHEN new.x THEN 1 ELSE 2 END; END; SELECT 3",
			["CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET v = CASE WHEN new.x THEN 1 ELSE 2 END; END", "SELECT 3"],
		],
		["SELECT CASE WHEN 1 THEN 2 END; SELECT 3", ["SELECT CASE WHEN 1 THEN 2 END", "SELECT 3"]],
	])("splits %j", (sql, expected) => {
		expect(splitSqlStatements(sql)).toEqual(expected)
	})
})

describe("normalizeSql", () => {
	it.each([
		["CREATE   TABLE\n\tt (a)", "CREATE TABLE t (a)"],
		["  -- lead\nSELECT 1 /* mid */ ;  -- tail", "SELECT 1 ;"],
		["SELECT 'a   b'", "SELECT 'a   b'"],
		["SELECT 1 -- note", "SELECT 1"],
	])("normalizes %j", (sql, expected) => {
		expect(normalizeSql(sql)).toBe(expected)
	})
})
