import { describe, expect, it } from "vitest"
import { pgStatements, pgUnreadable } from "./pg-split.ts"

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

describe("pgUnreadable: the first statement the parser cannot read", () => {
	it("names it with the parser's reason, and none when it reads them all", () => {
		expect(pgUnreadable("SELECT 1; SELEC 2; SELEC 3;")).toEqual({
			error: 'syntax error at or near "SELEC"',
			statement: "SELEC 2",
		})
		expect(pgUnreadable("SELECT 1;")).toBeUndefined()
	})
})
