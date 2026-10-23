import { describe, expect, it } from "vitest"
import { statementHead, statementTable, updatedColumns } from "./statement-head.ts"

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

/* U8 of the 0.12 round: a schema-qualified table is named by its table, as error maps key it */
describe("statementTable on a schema-qualified table", () => {
	it.each([
		['delete from "app"."parent" where "id" = $1', "parent"],
		['update "app"."pa""rent" set "x" = $1', 'pa"rent'],
		["insert into app.parent (id) values ($1)", "parent"],
		['delete from "app" . "parent"', "parent"],
		["delete from `app`.`parent`", "parent"],
		["delete from [app].[pa rent]", "pa rent"],
		['delete from "parent"', "parent"],
	])("reads %s as %s", (query, table) => {
		expect(statementTable(query)).toBe(table)
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
