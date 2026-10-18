import { describe, expect, it } from "vitest"
import { codeOf, lastPart, splitTopLevel, topLevel, unquote } from "./sql-code.ts"

describe("unquote and lastPart", () => {
	it.each([
		['"public"."post"', "public.post", "post"],
		["`post`", "post", "post"],
		["[dbo].[post]", "dbo.post", "post"],
		['"say ""hi"""', 'say "hi"', 'say "hi"'],
		["public . post", "public.post", "post"],
		["post", "post", "post"],
	])("reads %s as %s, table %s", (name, joined, last) => {
		expect(unquote(name)).toBe(joined)
		expect(lastPart(name)).toBe(last)
	})
})

describe("codeOf", () => {
	it("keeps identifiers, blanks strings and comments, and collapses whitespace", () => {
		expect(codeOf("DROP  TABLE \"post\" -- gone\n; SELECT 'x'", "postgres")).toBe('DROP TABLE "post" ; SELECT')
	})

	it("unwraps a DO body into the code it runs, an unterminated one too", () => {
		expect(codeOf("DO $d$ BEGIN DROP TABLE post; END $d$", "postgres")).toBe("DO BEGIN DROP TABLE post; END")
		expect(codeOf("DO $$ DROP TABLE post", "postgres")).toBe("DO DROP TABLE post")
	})

	it("leaves a function body out, as a string", () => {
		expect(codeOf("CREATE FUNCTION f() AS $$ DROP TABLE post $$", "postgres")).toBe("CREATE FUNCTION f() AS")
	})
})

describe("splitTopLevel and topLevel", () => {
	it("splits only at commas outside parentheses", () => {
		expect(splitTopLevel("ADD c numeric(10,2), DROP COLUMN d , ")).toEqual(["ADD c numeric(10,2)", "DROP COLUMN d"])
	})

	it("blanks every parenthesized group", () => {
		expect(topLevel("DELETE FROM t USING (SELECT 1 WHERE (x)) s")).toBe("DELETE FROM t USING                      s")
	})
})
