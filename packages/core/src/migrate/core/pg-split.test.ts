import { describe, expect, it } from "vitest"
import { atlasChunks } from "./atlas-scan.ts"
import { atlasFile, pgRead, pgStatements } from "./pg-split.ts"

describe("pgStatements: a Postgres file as the statements Postgres runs", () => {
	it("splits a chunk Atlas sends whole into each statement, by the parser's byte offsets", () => {
		expect(pgStatements("-- atlas:delimiter GO\nSELECT 'ž😀'; CREATE TABLE \"€\" (id int);DROP TABLE x\nGO\n")).toEqual(
			["SELECT 'ž😀'", 'CREATE TABLE "€" (id int)', "DROP TABLE x"],
		)
	})

	it("keeps the comments before a chunk on its first statement, and reads none from an empty one", () => {
		expect(pgStatements("-- a\nSELECT 1;\n;\n-- b\n;")).toEqual(["-- a\nSELECT 1"])
		/* a delimiter right after another sends Postgres an empty chunk */
		expect(pgStatements("-- atlas:delimiter GO\nGO\nSELECT 1 GO")).toEqual(["SELECT 1"])
	})

	it("keeps a chunk the parser cannot read whole", () => {
		expect(pgStatements("SELECT 1; SELEC 2; SELECT 3;")).toEqual(["SELECT 1", "SELEC 2", "SELECT 3"])
	})
})

describe("pgRead: the file read once, each statement's tree kept, and its first unreadable statement", () => {
	it("names the first statement the parser cannot read with its reason, and none when it reads them all", () => {
		const read = pgRead("SELECT 1; SELEC 2; SELEC 3;")
		expect(read.unreadable).toEqual({ error: 'syntax error at or near "SELEC"', statement: "SELEC 2" })
		expect(read.statements.map(({ tree }) => tree === undefined)).toEqual([false, true, true])
		expect(pgRead("SELECT 1;").unreadable).toBeUndefined()
	})
})

/* the one Postgres split, written back: a file Atlas sends each statement of alone, as Postgres reads it (M75) */
/** The statements Postgres reads in each chunk Atlas sends of `file` */
const sent = (file: string) => atlasChunks(file).map((chunk) => pgStatements(chunk.text))

describe("atlasFile: statements written so Atlas sends each one alone", () => {
	it("ends each with `;` when Atlas reads it so, the comments before it kept", () => {
		expect(atlasFile(["-- a\nSELECT 1", "CREATE TABLE t (id int)"])).toBe("-- a\nSELECT 1;\nCREATE TABLE t (id int);\n")
		expect(atlasFile([])).toBe("")
	})

	it("writes the file under a delimiter of its own when `;` would join or swallow a statement", () => {
		for (const statements of [
			["BEGIN TRANSACTION", "INSERT INTO t VALUES (1)", "END"],
			["CREATE TABLE t (id int) -- the ids", "SELECT 1"],
		]) {
			const file = atlasFile(statements)
			expect(file).toMatch(/^-- atlas:delimiter \S+\n\n/)
			expect(pgStatements(file)).toEqual(statements)
			expect(sent(file)).toEqual(statements.map((statement) => [statement]))
		}
	})

	it("puts the delimiter it needs first, before the file's other directives, and drops the one it had", () => {
		expect(atlasFile(["SELECT 1"], "-- atlas:delimiter GO\n-- atlas:txmode none\n\n")).toBe(
			"-- atlas:txmode none\n\nSELECT 1;\n",
		)
		expect(atlasFile(["SELECT 1 -- x"], "-- atlas:txmode none\n\n")).toMatch(
			/^-- atlas:delimiter (\S+)\n-- atlas:txmode none\n\nSELECT 1 -- x\n\1\n$/,
		)
		/* a directive with no blank line after it, which Atlas does not honor, stays so */
		expect(atlasFile(["SELECT 1"], "-- atlas:txmode none\n")).toBe("-- atlas:txmode none\nSELECT 1;\n")
		expect(atlasFile([], "-- atlas:txmode none\n\n")).toBe("-- atlas:txmode none\n\n")
	})

	it("takes a delimiter no statement holds", () => {
		const file = atlasFile(["SELECT '@comb0@' -- x"])
		expect(file.split("\n")[0]).toBe("-- atlas:delimiter @comb1@")
		expect(pgStatements(file)).toEqual(["SELECT '@comb0@' -- x"])
	})

	it("refuses statements Atlas splits wrongly either way, naming them", () => {
		/* Atlas reads no backslash escape, so its quote ends early where Postgres's does not */
		expect(() => atlasFile(["SELECT E'a\\'b'"])).toThrow(
			`comb cannot write these statements so that Atlas sends each alone: ["SELECT E'a\\\\'b'"]`,
		)
	})
})
