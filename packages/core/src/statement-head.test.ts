import { describe, expect, it } from "vitest"
import { statementHead } from "./statement-head.ts"

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
