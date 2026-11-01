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
		expect(await approveMigration(reviewed("DROP INDEX i;"), yes)).toEqual({ cautions: ["DROP INDEX i"], ok: true })
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

describe("approveMigration: what the refusal names", () => {
	it("names each statement once, and no drop a statement already shows, by what it drops (M18)", async () => {
		const { parseMigration } = await import("./parse.ts")
		const sql = "DROP TABLE `vote`;\nDROP TABLE IF EXISTS legacy;\nALTER TABLE post DROP COLUMN body;"
		const approval = await approveMigration(parseMigration(sql, "1_x.sql", { dialect: "sqlite" }), nobody)
		expect(approval).toEqual({
			message:
				'1_x.sql is unsafe (DROP TABLE `vote`; DROP TABLE IF EXISTS legacy; ALTER TABLE post DROP COLUMN body); confirm it on a terminal, or approve it in the file with a line "-- comb:allow-unsafe: <reason>"',
			ok: false,
		})
	})

	it("names a drop no statement shows, though one names a table that starts the same", async () => {
		const shown = { ...reviewed("DROP TABLE bb;"), drops: ["DROP TABLE b", "DROP TABLE bb"] }
		const approval = await approveMigration(shown, nobody)
		expect(approval.ok === false && approval.message).toMatch(/^2_x\.sql is unsafe \(DROP TABLE b; DROP TABLE bb\);/)
	})
})

/*
 * S4 of r19: a cautious note is shown wherever the file runs or is refused: beside an unsafe file's statements, under its
 * in-file approval, and when --yes runs a cautious file, so the note on a foreign_keys pragma reaches the author it is for
 */
describe("approveMigration's cautious notes, on every path a file takes", () => {
	const KEEP_CHILDREN = "PRAGMA foreign_keys = off;\nDROP TABLE parent;\nPRAGMA foreign_keys = on;"
	const note = /PRAGMA foreign_keys = off \(does nothing inside the transaction comb runs each file in/

	it("lists an unsafe file's cautious statements after its unsafe ones, each once", async () => {
		const refused = await approveMigration(reviewed(KEEP_CHILDREN), nobody)
		expect(refused.ok).toBe(false)
		const message = (refused as { message: string }).message
		expect(message).toMatch(
			/^2_x\.sql is unsafe \(DROP TABLE parent.*\); also cautious: \(PRAGMA foreign_keys = off \(/,
		)
		expect(message.match(new RegExp(note.source, "g"))).toHaveLength(1)
	})

	it("asks a person about the cautious statements too", async () => {
		const asked: string[] = []
		const confirm = (question: string) => {
			asked.push(question)
			return Promise.resolve(true)
		}
		expect(await approveMigration(reviewed(KEEP_CHILDREN), { ...nobody, confirm })).toEqual({ ok: true })
		expect(asked.join("\n")).toMatch(note)
	})

	it.each([
		["approved in the file", `-- comb:allow-unsafe: keep the children\n${KEEP_CHILDREN}`, nobody],
		[
			"cautious, run with --yes",
			"PRAGMA foreign_keys = off;\nCREATE TABLE t (id INTEGER PRIMARY KEY);",
			{ ...nobody, yes: true },
		],
	])("returns the cautious statements of a file %s, to print", async (_, sql, options) => {
		const approval = await approveMigration(reviewed(sql), options)
		expect(approval).toMatchObject({ ok: true })
		expect((approval as { cautions: string[] }).cautions).toEqual([expect.stringMatching(note)])
	})

	it("rates foreign_keys on, SQLite's own state inside comb's transaction, safe, so only off carries the note", () => {
		expect(classifyMigration("PRAGMA foreign_keys = on;", { dialect: "sqlite" }).safety).toBe("safe")
		expect(
			classifyMigration('PRAGMA foreign_keys = ON;\nPRAGMA "foreign_keys" = 1;', { dialect: "sqlite" }).safety,
		).toBe("safe")
		expect(classifyMigration("PRAGMA foreign_keys = off;", { dialect: "sqlite" }).cautiousStatements).toHaveLength(1)
	})
})
