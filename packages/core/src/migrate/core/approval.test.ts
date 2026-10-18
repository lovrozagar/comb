import { describe, expect, it } from "vitest"
import { approveMigration, inFileApproval } from "./approval.ts"
import { classifyMigration, extractDropStatements } from "./classify.ts"

const reviewed = (sql: string) => ({
	classification: classifyMigration(sql, { dialect: "sqlite" }),
	drops: extractDropStatements(sql, { dialect: "sqlite" }),
	filename: "2_x.sql",
	sql,
})
const nobody = { target: "core", yes: false }

describe("inFileApproval", () => {
	it.each([
		["-- comb:allow-unsafe: moved to the archive\nDROP TABLE post;", "moved to the archive"],
		["DROP TABLE post;\n  --comb:allow-unsafe:   kept a copy   \n", "kept a copy"],
		["-- comb:allow-unsafe:\nDROP TABLE post;", undefined],
		["-- comb:allow-unsafe:   \nDROP TABLE post;", undefined],
		["SELECT 1; -- comb:allow-unsafe: trailing\n", undefined],
		["DROP TABLE post;", undefined],
		["INSERT INTO t VALUES ('\n-- comb:allow-unsafe: smuggled\n');\nDROP TABLE post;", undefined],
		["/* x */ -- comb:allow-unsafe: after a comment\nDROP TABLE post;", undefined],
	])("reads %j as %j", (sql, reason) => {
		expect(inFileApproval(sql)).toBe(reason)
	})
})

describe("inFileApproval on Postgres", () => {
	it("reads no approval inside a function body, and one after it", () => {
		const body = "CREATE FUNCTION f() RETURNS void AS $$\n-- comb:allow-unsafe: smuggled\n$$ LANGUAGE sql;"
		expect(inFileApproval(body, "postgres")).toBeUndefined()
		expect(inFileApproval(`${body}\n-- comb:allow-unsafe: reviewed`, "postgres")).toBe("reviewed")
	})
})

describe("approveMigration", () => {
	it("lets a safe file run without asking", async () => {
		expect(await approveMigration(reviewed("CREATE TABLE a (x);"), nobody)).toEqual({ ok: true })
	})

	it("lets --yes cover a cautious file and not an unsafe one", async () => {
		const yes = { target: "core", yes: true }
		expect(await approveMigration(reviewed("DROP INDEX i;"), yes)).toEqual({ ok: true })
		expect(await approveMigration(reviewed("DROP TABLE post;"), yes)).toMatchObject({ ok: false })
	})

	it("asks a person, naming what the file drops, and takes the answer", async () => {
		const asked: string[] = []
		const answer = (yes: boolean) => async (question: string) => (asked.push(question), yes)
		const sql = "DROP TABLE post;"
		expect(await approveMigration(reviewed(sql), { confirm: answer(true), target: "core", yes: true })).toEqual({
			ok: true,
		})
		expect(await approveMigration(reviewed(sql), { confirm: answer(false), target: "core", yes: false })).toMatchObject(
			{ ok: false },
		)
		expect(asked[0]).toContain("1. DROP TABLE post")
		expect(asked[0]).toContain("This affects: core")
	})

	it("takes the file's own approval of an unsafe file and reports it", async () => {
		const sql = "-- comb:allow-unsafe: archived\nDROP TABLE post;"
		expect(await approveMigration(reviewed(sql), nobody)).toEqual({ approvedBy: "archived", ok: true })
	})

	it("takes no in-file approval for a cautious file, which --yes covers", async () => {
		const sql = "-- comb:allow-unsafe: archived\nDROP INDEX i;"
		expect(await approveMigration(reviewed(sql), nobody)).toEqual({
			message: "2_x.sql is cautious (DROP INDEX i); pass --yes or confirm it on a terminal",
			ok: false,
		})
	})

	it("says how to approve an unsafe file it refuses", async () => {
		expect(await approveMigration(reviewed("TRUNCATE post;"), nobody)).toEqual({
			message:
				'2_x.sql is unsafe (TRUNCATE post); confirm it on a terminal, or approve it in the file with a line "-- comb:allow-unsafe: <reason>"',
			ok: false,
		})
	})
})
