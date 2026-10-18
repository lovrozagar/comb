import { describe, expect, it } from "vitest"
import { normalizeSql, segments, splitSqlStatements } from "./sql-scan.ts"

const kinds = (sql: string) => segments(sql).map(({ kind, text }) => `${kind}:${text}`)
const pg = (sql: string) => segments(sql, "postgres").map(({ kind, text }) => `${kind}:${text}`)

describe("segments", () => {
	/* the last case: in brackets a doubled ] is no escape, the first ] closes */
	it.each([
		["'a;b'", ["literal:'a;b'"]],
		['"a;b"', ['identifier:"a;b"']],
		["`a;b`", ["identifier:`a;b`"]],
		["[a;b]", ["identifier:[a;b]"]],
		["'it''s'", ["literal:'it''s'"]],
		['"say ""hi"""', ['identifier:"say ""hi"""']],
		["[a]]b", ["identifier:[a]", "code:]b"]],
	])("reads %s as one string or identifier", (sql, expected) => {
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

describe("segments on Postgres: quotes and comments", () => {
	it("reads a double-quoted identifier as an identifier, and leaves [ and ` to the code", () => {
		expect(pg('ALTER TABLE "public"."post"')).toEqual([
			"code:ALTER TABLE ",
			'identifier:"public"',
			"code:.",
			'identifier:"post"',
		])
		expect(pg("SELECT a[1], `b`")).toEqual(["code:SELECT a[1], `b`"])
	})

	it("reads backslash escapes in an E string, so a \\' does not close it", () => {
		expect(pg("SELECT E'\\''; DROP TABLE post; -- ';")).toEqual([
			"code:SELECT E",
			"literal:'\\''",
			"code:; DROP TABLE post; ",
			"comment:-- ';",
		])
		expect(pg("SELECT e'a\\\\'")).toEqual(["code:SELECT e", "literal:'a\\\\'"])
		expect(pg("SELECT de'x'")).toEqual(["code:SELECT de", "literal:'x'"])
	})

	it("reads a U& string and a U& identifier with doubled quotes", () => {
		expect(pg("SELECT U&'d\\0061''t', U&\"c\"\"d\"")).toEqual([
			"code:SELECT U&",
			"literal:'d\\0061''t'",
			"code:, U&",
			'identifier:"c""d"',
		])
	})

	it("nests block comments, so code after an inner */ is still comment", () => {
		expect(pg("a /* x /* y */ DROP TABLE t; */ b")).toEqual([
			"code:a ",
			"comment:/* x /* y */ DROP TABLE t; */",
			"code: b",
		])
		expect(pg("a /* x /* y */")).toEqual(["code:a ", "comment:/* x /* y */"])
	})
})

describe("segments on Postgres: dollar quotes", () => {
	it("reads a dollar quote to its own tag, a different tag inside it included", () => {
		expect(pg("SELECT $$a;'b$$")).toEqual(["code:SELECT ", "literal:$$a;'b$$"])
		expect(pg("SELECT $a$ x $b$ y $b$ z $a$ w")).toEqual(["code:SELECT ", "literal:$a$ x $b$ y $b$ z $a$", "code: w"])
		expect(pg("SELECT $open$ x")).toEqual(["code:SELECT ", "literal:$open$ x"])
	})

	it("reads a string, an E string and a dollar quote that open the text", () => {
		expect(pg("'a' x")).toEqual(["literal:'a'", "code: x"])
		expect(pg("E'\\'' x")).toEqual(["code:E", "literal:'\\''", "code: x"])
		expect(pg("$$a$$ x")).toEqual(["literal:$$a$$", "code: x"])
	})

	it("opens no dollar quote at a positional parameter or inside an identifier", () => {
		expect(pg("SELECT $1, a$b$ FROM t")).toEqual(["code:SELECT $1, a$b$ FROM t"])
		expect(pg("SELECT $1$")).toEqual(["code:SELECT $1$"])
	})

	it("reads a DO body as executed code and a function body as a literal", () => {
		expect(pg("DO $$ BEGIN DROP TABLE post; END $$")).toEqual(["code:DO ", "body:$$ BEGIN DROP TABLE post; END $$"])
		expect(pg("do language plpgsql $d$ BEGIN END $d$")).toEqual(["code:do language plpgsql ", "body:$d$ BEGIN END $d$"])
		expect(pg("SELECT 1; DO $$ x $$")).toEqual(["code:SELECT 1; DO ", "body:$$ x $$"])
		expect(pg("CREATE FUNCTION f() RETURNS void AS $$ DROP TABLE post $$ LANGUAGE sql")).toEqual([
			"code:CREATE FUNCTION f() RETURNS void AS ",
			"literal:$$ DROP TABLE post $$",
			"code: LANGUAGE sql",
		])
	})

	it("keeps SQLite's reading by default: flat comments, plain strings, $ as code", () => {
		expect(kinds("a /* x /* y */ b */")).toEqual(["code:a ", "comment:/* x /* y */", "code: b */"])
		expect(kinds("SELECT E'\\'")).toEqual(["code:SELECT E", "literal:'\\'"])
		expect(kinds("SELECT $$a$$")).toEqual(["code:SELECT $$a$$"])
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

	it("splits Postgres at no ; inside a dollar quote or a DO body", () => {
		expect(splitSqlStatements("DO $$ BEGIN DROP TABLE a; END $$; SELECT $x$;$x$", "postgres")).toEqual([
			"DO $$ BEGIN DROP TABLE a; END $$",
			"SELECT $x$;$x$",
		])
	})
})

describe("normalizeSql", () => {
	it.each([
		["CREATE   TABLE\n\tt (a)", "CREATE TABLE t (a)"],
		["  -- lead\nSELECT 1 /* mid */ ;  -- tail", "SELECT 1 ;"],
		["SELECT 'a   b'", "SELECT 'a   b'"],
		["SELECT 1 -- note", "SELECT 1"],
		['SELECT "a   b"', 'SELECT "a   b"'],
	])("normalizes %j", (sql, expected) => {
		expect(normalizeSql(sql)).toBe(expected)
	})
})
