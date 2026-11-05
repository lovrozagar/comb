import { describe, expect, it } from "vitest"
import { insertedColumns, statementHead, statementTable, updatedColumns } from "./statement-head.ts"

describe("statementHead", () => {
	it("starts at the statement's own verb, past comments and common table expressions", () => {
		expect(statementHead('  delete from "t"')).toBe('delete from "t"')
		expect(statementHead('/* purge */ -- now\ndelete from "t"')).toBe('delete from "t"')
		expect(statementHead('with a as (select 1), "delete" as (delete from x) update "t" set b = 1')).toBe(
			'update "t" set b = 1',
		)
		expect(statementHead("WITH RECURSIVE n(i) AS (SELECT 1) INSERT INTO t SELECT i FROM n")).toBe(
			"INSERT INTO t SELECT i FROM n",
		)
	})

	it("takes no word inside a literal, a quoted name or a bracketed name for the verb", () => {
		expect(statementHead("with x as (select 'delete') select * from [delete] where `update` = 'it''s'")).toBe(
			"select * from [delete] where `update` = 'it''s'",
		)
	})

	it("keeps text it cannot read, and reads unclosed comments and quotes to the end", () => {
		expect(statementHead("")).toBe("")
		expect(statementHead("-- only a comment")).toBe("")
		expect(statementHead("/* open")).toBe("")
		expect(statementHead("with x")).toBe("with x")
		expect(statementHead("vacuum")).toBe("vacuum")
		expect(statementHead("with x as ('unclosed")).toBe("with x as ('unclosed")
		expect(statementHead("with x as ([unclosed")).toBe("with x as ([unclosed")
	})
})

/* U8 of the 0.12 round and QE8 of r22b: a schema-qualified table is read as its schema and its
 * table, so Postgres keys it as every other violation does and SQLite by its table */
describe("statementTable on a schema-qualified table", () => {
	it.each([
		['delete from "app"."parent" where "id" = $1', "app", "parent"],
		['update "app"."pa""rent" set "x" = $1', "app", 'pa"rent'],
		["insert into app.parent (id) values ($1)", "app", "parent"],
		['delete from "app" . "parent"', "app", "parent"],
		["delete from `app`.`parent`", "app", "parent"],
		["delete from [my app].[pa rent]", "my app", "pa rent"],
		['delete from db."app"."parent"', "app", "parent"],
		['delete from "parent"', undefined, "parent"],
	])("reads %s as %s.%s", (query, schema, table) => {
		expect(statementTable(query, "postgres")).toEqual({ schema, table })
		expect(statementTable(query, "sqlite")).toEqual({ schema, table })
	})

	/* B2-10b of area B: a comment between the verb and the table is space, a quoted table a token of its own */
	it.each([
		["delete from /* x */ t where id = 1", "t"],
		["update -- x\n t set a = 1", "t"],
		['insert into"t"(a) values (1)', "t"],
		["delete from t/* x */where id = 1", "t"],
	])("reads %s as %s on both dialects", (query, table) => {
		expect(statementTable(query, "postgres")).toEqual({ schema: undefined, table })
		expect(statementTable(query, "sqlite")).toEqual({ schema: undefined, table })
	})

	/* AB7 of area B: Postgres's ONLY, a reserved word there, is no table */
	it.each([
		['DELETE FROM ONLY "app"."org" WHERE id = $1', "app", "org"],
		['UPDATE ONLY "app"."org" SET id = $1', "app", "org"],
		["update only app.org set id = $1", "app", "org"],
		["UPDATE ONLY o SET a = 1", undefined, "o"],
		["delete from only_org where id = 1", undefined, "only_org"],
		["update only /* audit */ t set a = 1", undefined, "t"],
		["delete from only -- audit\n app.org where id = 1", "app", "org"],
	])("reads %s on Postgres as %s.%s", (query, schema, table) => {
		expect(statementTable(query, "postgres")).toEqual({ schema, table })
	})

	/* B2-10 of area B: SQLite has no ONLY, so only names a table there, a bare alias or a comment after it */
	it.each([
		["update only o set a = 1", undefined, "only"],
		["delete from only o where o.id = 1", undefined, "only"],
		["update only /* audit */ set a = 1", undefined, "only"],
		["delete from only where id = 1", undefined, "only"],
		["delete from only", undefined, "only"],
		["update only set a = 1", undefined, "only"],
		["update only as o set a = 1", undefined, "only"],
	])("reads %s on SQLite as %s.%s", (query, schema, table) => {
		expect(statementTable(query, "sqlite")).toEqual({ schema, table })
	})
})

/* AB3-8 of area B: a write's table as the server resolves it, past what the dialect allows after its name */
describe("statementTable reads the table the dialect writes", () => {
	it.each([
		["DELETE FROM org;", undefined, "org"],
		["delete from app.org;", "app", "org"],
		['update "org"; ', undefined, "org"],
	])("reads %s on both dialects as %s.%s, past its ;", (query, schema, table) => {
		expect(statementTable(query, "postgres")).toEqual({ schema, table })
		expect(statementTable(query, "sqlite")).toEqual({ schema, table })
	})

	it.each([
		["DELETE FROM ONLY (org) WHERE id = 1", undefined, "org"],
		["delete from only(org)", undefined, "org"],
		["UPDATE ONLY ( App . Org ) SET a = 1", "app", "org"],
		['update only ("App"."Org") set a = 1', "App", "Org"],
		["DELETE FROM org* WHERE id = 1", undefined, "org"],
		["delete from app.org * where id = 1", "app", "org"],
		["UPDATE org* SET a = 1", undefined, "org"],
		["DELETE FROM Org WHERE id = 1", undefined, "org"],
		["DELETE FROM App.Org WHERE id = 1", "app", "org"],
		['DELETE FROM "App".Org', "App", "org"],
		["INSERT INTO ORG (id) VALUES (1)", undefined, "org"],
		["delete from OrgÉ", undefined, "orgÉ"],
	])("reads %s on Postgres as %s.%s", (query, schema, table) => {
		expect(statementTable(query, "postgres")).toEqual({ schema, table })
	})

	it.each([
		["DELETE FROM 'org' WHERE id = 1", undefined, "org"],
		["delete from main.'org'", "main", "org"],
		["insert into 'o''rg' (id) values (1)", undefined, "o'rg"],
		["update or abort 'org' set id = 3", undefined, "org"],
		["replace into 'org' values (4)", undefined, "org"],
		["delete from Org", undefined, "Org"],
	])("reads %s on SQLite as %s.%s", (query, schema, table) => {
		expect(statementTable(query, "sqlite")).toEqual({ schema, table })
	})
})

/* U6 of the 0.12 round: which columns an UPDATE sets, read up to its WHERE, FROM or RETURNING */
describe("updatedColumns", () => {
	it.each([
		['update "team" set "id" = ? where "id" = ?', ["id"]],
		['update or abort "app"."team" set "name" = ?, "org_id" = ? returning "id"', ["name", "org_id"]],
		["update team as t set org_id = s.org_id from s where t.id = s.id", ["org_id"]],
		['update "team" set "note" = \'a where b\'', ["note"]],
		['update "team" set "a""b" = coalesce("x", ?)', ['a"b']],
	])("reads %s", (query, columns) => {
		expect(updatedColumns(query)).toEqual(columns)
	})

	it("reads no UPDATE as nothing", () => {
		expect(updatedColumns('delete from "team"')).toBeUndefined()
		expect(updatedColumns(undefined)).toBeUndefined()
	})
})

/* the 3.2 review of U6: a row-value SET, a literal holding a comma, and an index the UPDATE names */
describe("updatedColumns, as SQLite writes an UPDATE", () => {
	it.each([
		['update "m" set ("owner_id", "name") = (?, ?)', ["owner_id", "name"]],
		['update "m" set "name" = \'x, owner_id = 1\'', ["name"]],
		['update "m" indexed by "ix" set "name" = ?', ["name"]],
		['update "m" not indexed set "name" = ?, (a, "b") = (select 1, 2)', ["name", "a", "b"]],
		['update "m" as x indexed by ix set name = ?', ["name"]],
		/* what is no assignment's head reads as no column: an expression, or an empty list */
		['update "m" set .x = 2, "name" = ?', ["name"]],
		['update "m" set () = ()', []],
	])("reads %s", (query, columns) => {
		expect(updatedColumns(query)).toEqual(columns)
	})
})

/* AB7 and B2-10 of area B: SQLite, the reader's one dialect, has no ONLY, so a table named only is a table */
describe("updatedColumns on a table named only", () => {
	it("reads the SET list after a table named only, aliased or not", () => {
		expect(updatedColumns('update only as o set id = ?, "name" = ? where id = ?')).toEqual(["id", "name"])
		expect(updatedColumns("update only set a = 1")).toEqual(["a"])
	})
})

/* AB4 of area B: the SQLite handler blames a lone foreign key on an INSERT only where its list names it */
describe("insertedColumns", () => {
	it("reads an INSERT's column list, unquoted, past an alias, a comment and a CTE", () => {
		expect(insertedColumns("INSERT INTO author (id, org_id) VALUES ('a', 'b')")).toEqual(["id", "org_id"])
		expect(insertedColumns('insert or replace into "author"("id", [org_id], `x`) values (?, ?, ?)')).toEqual([
			"id",
			"org_id",
			"x",
		])
		expect(insertedColumns('REPLACE INTO t AS n ("a)b", c) SELECT 1, 2')).toEqual(["a)b", "c"])
		expect(insertedColumns("/* seed */ WITH s AS (SELECT 1) INSERT INTO main.t (a) SELECT * FROM s")).toEqual(["a"])
	})

	it("is undefined for an INSERT with no list, any other statement, no SQL, and reads an unclosed list to its end", () => {
		expect(insertedColumns("INSERT INTO t VALUES (1)")).toBeUndefined()
		expect(insertedColumns("INSERT INTO t DEFAULT VALUES")).toBeUndefined()
		expect(insertedColumns("UPDATE t SET a = 1")).toBeUndefined()
		expect(insertedColumns(undefined)).toBeUndefined()
		expect(insertedColumns("INSERT INTO t (a, b")).toEqual(["a", "b"])
	})

	/* gate fix for 5bd746b8: a piece naming no column is read as none, so the classifier never throws on it */
	it("reads an empty list, or one holding an empty piece, as the columns it names", () => {
		expect(insertedColumns("INSERT INTO t () VALUES ()")).toEqual([])
		expect(insertedColumns("INSERT INTO t (a, , b) VALUES (1, 2)")).toEqual(["a", "b"])
	})
})
