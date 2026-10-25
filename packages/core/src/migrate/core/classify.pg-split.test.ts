/**
 * M75 of the 0.13.0 round: a Postgres file is read as the statements Postgres runs, Atlas's chunks
 * (atlas-scan.ts) each split by the parser, so no statement is cut at a `;` inside a BEGIN ATOMIC
 * body or a rule's action list, none merged into the one before it, and `-- atlas:delimiter` holds;
 * a history statement the parser cannot read fails the classification, never a silent skip.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration, extractDropStatements } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const BASE =
	"CREATE TABLE victim (id int); CREATE TABLE a (id int); CREATE TABLE t (id int); CREATE TABLE users (id int);"

/** `later` classified after BASE and `history`, read as Postgres, with the drops it makes */
function classify(history: string, later: string) {
	const options = { before: extractSchema(`${BASE}\n${history}`, undefined, "postgres"), dialect: "postgres" as const }
	return { ...classifyMigration(later, options), drops: extractDropStatements(later, options) }
}

describe("a history statement Postgres runs whole (M75)", () => {
	it("keeps a BEGIN ATOMIC function whole, so a later call runs its body", () => {
		const history =
			"CREATE FUNCTION lower(int) RETURNS int LANGUAGE sql BEGIN ATOMIC DELETE FROM victim; SELECT 1; END;"
		expect(classify(history, "INSERT INTO a SELECT lower(5);").unsafeStatements.join(" ")).toContain(
			"calls lower, a function a migration defined",
		)
	})

	it("keeps a rule's action list whole, so a later write runs the rule", () => {
		const history = "CREATE RULE r AS ON INSERT TO t DO ALSO (INSERT INTO a VALUES (1); DELETE FROM victim);"
		expect(classify(history, "INSERT INTO t VALUES (1);").unsafeStatements.join(" ")).toContain("runs rule r")
	})

	it("fails the classification on a history statement the parser cannot read, naming it", () => {
		expect(() => classify("CREATE TABLE b (id int) GO;", "INSERT INTO a VALUES (1);")).toThrow(
			/comb could not read the history: "CREATE TABLE b \(id int\) GO" \(syntax error at or near "GO"\)/,
		)
	})
})

describe("a file's statements, as Atlas splits it and Postgres runs it (M75)", () => {
	it("splits a trigger on a column named begin from the drop after it", () => {
		const sql =
			"CREATE TABLE events (id int, begin int);\nCREATE TRIGGER g BEFORE UPDATE OF begin ON events FOR EACH ROW EXECUTE FUNCTION f();\nDROP TABLE users;\n"
		const result = classify("", sql)
		expect(result.drops).toEqual(["DROP TABLE users"])
		/* the drop is a statement of its own, as the approval question lists it */
		expect(result.unsafeStatements).toContain("DROP TABLE users")
	})

	it("splits at -- atlas:delimiter's delimiter, and only there", () => {
		const sql = "-- atlas:delimiter GO\n\nCREATE TABLE x (id int)\nGO\nDROP TABLE users\nGO\n"
		const result = classify("", sql)
		expect(result.drops).toEqual(["DROP TABLE users"])
		expect(result.unsafeStatements.join(" ")).not.toContain("could not parse")
	})

	it("keeps a custom delimiter inside a dollar-quoted body, as Atlas does", () => {
		const sql =
			"-- atlas:delimiter GO\n\nCREATE FUNCTION g() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; GO END $$\nGO\nDROP TABLE users\nGO\n"
		const result = classify("", sql)
		expect(result.drops).toEqual(["DROP TABLE users"])
		expect(result.unsafeStatements.join(" ")).not.toContain("could not parse")
	})

	it("cuts a dollar-quoted body at a delimiter that opens with $, as Atlas does", () => {
		const sql =
			"-- atlas:delimiter $$\nCREATE FUNCTION g() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$\nDROP TABLE users$$\n"
		const result = classify("", sql)
		expect(result.unsafeStatements.join(" ")).toContain("could not parse")
		expect(result.drops).toEqual(["DROP TABLE users"])
	})

	it("reads every statement of a chunk Atlas sends whole, as Postgres runs them all", () => {
		const sql = "-- atlas:delimiter GO\nCREATE TABLE b (id int); DROP TABLE users\nGO\n"
		expect(classify("", sql).drops).toEqual(["DROP TABLE users"])
	})

	it("refuses a file Atlas cannot split, with Atlas's reason", () => {
		expect(() => classify("", "SELECT (1;\nDROP TABLE users;\n")).toThrow(
			"Atlas cannot split this file: 1:8: unclosed '('",
		)
	})
})
