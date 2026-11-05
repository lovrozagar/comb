import { describe, expect, it } from "vitest"
import { hashedSql, normalizeSql, splitSqlStatements } from "./sql-scan.ts"
import { CORPUS, corpusFile } from "../__fixtures__/trigger-corpus.ts"

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

describe("a SQLite file splits where SQLite ends a statement (SL2; sibling: libsql's skipped tail)", () => {
	it.each(CORPUS.map(({ label, statements }) => [label, statements]))(
		"splits %s as SQLite reads it",
		(_, statements) => {
			expect(splitSqlStatements(corpusFile(statements))).toEqual(statements)
		},
	)

	it.each([
		["a TEMP trigger over begin", "CREATE TEMP TRIGGER t AFTER INSERT ON begin BEGIN SELECT new.end; END"],
		["a TEMPORARY trigger", "CREATE TEMPORARY TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; SELECT 2; END"],
		["an EXPLAIN of a trigger", "EXPLAIN CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END"],
		["a trigger over a table named trigger", 'CREATE TRIGGER "trigger" AFTER INSERT ON a BEGIN SELECT end FROM e; END'],
		["a create table naming end and temp", "CREATE TABLE temp (end INTEGER, trigger TEXT)"],
	])("splits %s, then the statement after it", (_, first) => {
		expect(splitSqlStatements(`${first};\nSELECT 9;`)).toEqual([first, "SELECT 9"])
	})

	it("ends a trigger at END and ; alone: a ; after a body statement leaves it open", () => {
		expect(splitSqlStatements("CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; SELECT end; END; SELECT 2")).toEqual([
			"CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; SELECT end; END",
			"SELECT 2",
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

	/* SL5 of r22: SQLite's whitespace is space, tab, newline, form feed and return; any other space is part of a name */
	it.each([
		["a column a of type b, and a column named a b", "CREATE TABLE t (a b)", "CREATE TABLE t (a b)"],
		["an em space", "CREATE TABLE t (a b)", "CREATE TABLE t (a b)"],
		["a byte order mark at the end", "SELECT 1", "SELECT 1﻿"],
	])("keeps a space SQLite reads as part of a name apart from one it skips: %s", (_, ascii, unicode) => {
		expect(normalizeSql(` ${ascii.replace(" ", " \t\n\f\r ")} `)).toBe(ascii)
		expect(normalizeSql(unicode)).toBe(unicode)
		expect(normalizeSql(unicode)).not.toBe(normalizeSql(ascii))
	})

	it.each([
		['ALTER TABLE "users"DROP COLUMN email', 'ALTER TABLE "users" DROP COLUMN email'],
		["INSERT INTO`t`(a)SELECT`a`FROM`s`", "INSERT INTO `t`(a)SELECT `a` FROM `s`"],
		["PRAGMA[query_only]= ON", "PRAGMA [query_only]= ON"],
		['SELECT "main".t, t."x", "a"(1), X\'ab\'', 'SELECT "main".t, t."x", "a"(1), X\'ab\''],
	])("sets a quoted name off from a word written against it, as SQLite tokenizes %j, and nothing else", (sql, read) => {
		expect(normalizeSql(sql)).toBe(read)
	})
})

describe("hashedSql", () => {
	it("keeps a word written against a quoted name against it, as the recorded hash reads it", () => {
		expect(hashedSql('ALTER  TABLE "users"DROP -- c\n COLUMN email')).toBe('ALTER TABLE "users"DROP COLUMN email')
	})

	it("folds every Unicode space under foldAll, the 0.5.0 to 0.20 form (SL5 of r22)", () => {
		expect(hashedSql(" CREATE TABLE t (a\u2003b) ", true)).toBe("CREATE TABLE t (a b)")
	})
})
