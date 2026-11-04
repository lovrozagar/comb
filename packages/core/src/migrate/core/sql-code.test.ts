import { describe, expect, it } from "vitest"
import { codeOf, lastPart, namesIn, splitTopLevel, sqliteNames, topLevel, unquote } from "./sql-code.ts"

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

/* P2 of r22: the names a file spells, which a change past its database must name to be the file's */
describe("namesIn", () => {
	it("folds an unquoted name as Postgres does and keeps a quoted one exact", () => {
		expect(namesIn("CREATE ROLE Svc")).toContain("svc")
		expect(namesIn("CREATE ROLE Svc")).not.toContain("Svc")
		expect(namesIn('CREATE ROLE "Svc"')).toContain("Svc")
		expect(namesIn('CREATE ROLE "Svc"')).not.toContain("svc")
	})

	it("reads a string as its exact contents and as the SQL it may be, through every quote", () => {
		const dblink = namesIn("SELECT dblink_exec('dbname=x', 'CREATE ROLE Svc')")
		expect(dblink).toContain("svc")
		expect(dblink).toContain("CREATE ROLE Svc")
		expect(namesIn("DO $$ BEGIN EXECUTE format('CREATE ROLE %I', 'x'); END $$")).toContain("x")
		expect(namesIn('SELECT f($b$CREATE DATABASE "Big"$b$)')).toContain("Big")
		expect(namesIn("SELECT dblink_exec('', 'CREATE ROLE ''Odd''')")).toContain("Odd")
	})

	it("cuts a name to the 63 bytes Postgres keeps, at a character, and reads no comment", () => {
		expect(namesIn(`CREATE ROLE ${"a".repeat(70)}`)).toContain("a".repeat(63))
		expect(namesIn(`CREATE ROLE "${"é".repeat(40)}"`)).toContain("é".repeat(31))
		expect(namesIn("SELECT 1 -- ghost\n/* spook */")).not.toContain("ghost")
		expect(namesIn("SELECT 1 /* spook */")).not.toContain("spook")
	})
})

describe("sqliteNames: the names SQLite code spells (8.5 of plan 21)", () => {
	it("reads each bare and quoted name folded as SQLite resolves it, and each word of a string, but no comment", () => {
		const sql = `UPDATE "My""T" SET [Col] = \`B\` -- Gone\nWHERE x = 'Inside Out' /* Away */ AND Über = 1;`
		expect([...sqliteNames(sql)].toSorted()).toEqual(
			["and", "b", "col", "inside", 'my"t', "out", "set", "update", "where", "x", "Über"].toSorted(),
		)
	})
})
