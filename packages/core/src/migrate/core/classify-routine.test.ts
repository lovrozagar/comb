import { describe, expect, it } from "vitest"
import type { Finding } from "./classify-alter.ts"
import { callFindings, routinesOf } from "./classify-routine.ts"
import { codeOf } from "./sql-code.ts"

const read = (body: string): Finding[] => (/DELETE/i.test(body) ? [{ level: "unsafe" }] : [])

/** The routines of `statements` as Postgres reads them */
function routines(statements: string[]) {
	return routinesOf(
		{ codes: statements.map((stmt) => codeOf(stmt, "postgres")), dialect: "postgres", statements },
		read,
	)
}

describe("routinesOf", () => {
	it("reads each routine's body: what a call runs, nothing for a harmless one, cautious for one it cannot read", () => {
		const found = routines([
			"CREATE FUNCTION Wipe() RETURNS void AS $$ BEGIN DELETE FROM users; END $$ LANGUAGE plpgsql",
			"CREATE PROCEDURE ok() LANGUAGE sql AS $$ SELECT 1 $$",
			"CREATE FUNCTION py() RETURNS int LANGUAGE plpython3u AS $$ return 1 $$",
			"CREATE FUNCTION atomic() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END",
		])
		expect([...found]).toEqual([
			["wipe", { level: "unsafe", note: "calls wipe, whose body loses data" }],
			["ok", undefined],
			["py", { level: "cautious", note: "calls py, whose body comb cannot read" }],
			["atomic", { level: "cautious", note: "calls atomic, whose body comb cannot read" }],
		])
		const changing = routinesOf(
			{
				codes: ["CREATE FUNCTION up() RETURNS void LANGUAGE sql AS"],
				dialect: "postgres",
				statements: ["CREATE FUNCTION up() RETURNS void LANGUAGE sql AS 'x'"],
			},
			() => [{ level: "lock" }, { level: "cautious" }],
		)
		expect(changing.get("up")).toEqual({ level: "cautious", note: "calls up, whose body changes data" })
		const strictestFirst = routinesOf(
			{
				codes: ["CREATE FUNCTION up() RETURNS void LANGUAGE sql AS"],
				dialect: "postgres",
				statements: ["CREATE FUNCTION up() RETURNS void LANGUAGE sql AS 'x'"],
			},
			() => [{ level: "unsafe" }, { level: "cautious" }],
		)
		expect(strictestFirst.get("up")?.level).toBe("unsafe")
	})
})

describe("callFindings", () => {
	const known = {
		dialect: "postgres" as const,
		earlier: new Set(["old"]),
		routines: routines([
			"CREATE FUNCTION wipe() RETURNS void AS $$ DELETE FROM users $$ LANGUAGE sql",
			"CREATE FUNCTION ok() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql",
		]),
	}

	it("gives a call anywhere in a statement its routine's finding, and an earlier file's routine cautious", () => {
		expect(callFindings("INSERT INTO log VALUES (WIPE())", known)).toEqual([
			{ level: "unsafe", note: "calls wipe, whose body loses data" },
		])
		expect(callFindings("SELECT ok(), old()", known)).toEqual([
			{ level: "cautious", note: "calls old, which an earlier migration created" },
		])
		expect(callFindings("SELECT count(*) FROM t", known)).toEqual([])
	})

	it("reads no call in the statement that creates a routine", () => {
		expect(callFindings("CREATE FUNCTION wipe() RETURNS void AS LANGUAGE sql", known)).toEqual([])
	})
})

describe("callFindings on a Postgres built-in that destroys data or runs unread SQL (M14)", () => {
	const none = {
		dialect: "postgres" as const,
		earlier: new Set<string>(),
		routines: new Map<string, Finding | undefined>(),
	}

	it("rates a large-object delete unsafe and unread or session-ending calls cautious, wherever they are", () => {
		expect(callFindings("SELECT lo_unlink(oid) FROM docs", none)).toEqual([
			{ level: "unsafe", note: "calls lo_unlink, which deletes a large object" },
		])
		expect(callFindings("INSERT INTO log SELECT pg_catalog.lo_truncate(fd, 0)", none)[0]?.level).toBe("unsafe")
		expect(callFindings("SELECT dblink_exec('conn', 'DELETE FROM t')", none)[0]?.level).toBe("cautious")
		expect(callFindings("SELECT pg_terminate_backend(pid) FROM pg_stat_activity", none)[0]?.level).toBe("cautious")
	})

	it("reads a routine the file creates under a built-in's name as that routine, and SQLite not at all", () => {
		const own = { ...none, routines: new Map([["lo_unlink", undefined]]) }
		expect(callFindings("SELECT lo_unlink(1)", own)).toEqual([])
		expect(callFindings("SELECT lo_unlink(1)", { ...none, dialect: "sqlite" })).toEqual([])
	})
})
