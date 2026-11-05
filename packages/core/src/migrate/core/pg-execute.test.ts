/**
 * PA15 of r22b: a Postgres file's EXECUTE rated by the statement the file prepared, wherever it
 * stands (AE2-2 of r22), or as one comb cannot read, as the pinned Atlas runs it
 * (tests/integration/postgres/copy-execute-oracle.test.ts).
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

/** `sql`'s rating after a table t, read as Postgres */
const rate = (sql: string) =>
	classifyMigration(sql, {
		before: extractSchema("CREATE TABLE t (id int);", undefined, "postgres"),
		dialect: "postgres",
	})

/** `sql`'s level and the notes its statements carry */
const rated = (sql: string) => {
	const { cautiousStatements, safety, unsafeStatements } = rate(sql)
	return { cautiousStatements, safety, unsafeStatements }
}

describe("an EXECUTE (PA15 of r22b)", () => {
	it("is the statement the file prepared", () => {
		expect(rated("PREPARE p AS SELECT 1;\nEXECUTE p;")).toEqual({
			cautiousStatements: [
				"PREPARE p AS SELECT 1 (prepares a statement for an EXECUTE, which comb rates by the statement it runs)",
			],
			safety: "cautious",
			unsafeStatements: [],
		})
		expect(rate("PREPARE p (int) AS DELETE FROM t WHERE id = $1;\nEXECUTE p(1);").unsafeStatements).toEqual([
			"EXECUTE p(1) (deletes rows of t)",
		])
		expect(rate('PREPARE "P" AS UPDATE t SET id = 2;\nEXECUTE "P";').unsafeStatements).toEqual([
			'EXECUTE "P" (updates existing rows of t (id))',
		])
	})

	/* AE2-2 of r22: Postgres runs an EXECUTE inside a CREATE TABLE AS or an EXPLAIN ANALYZE as it runs a bare one */
	it.each(["CREATE TABLE x AS EXECUTE p", "EXPLAIN ANALYZE EXECUTE p", "EXPLAIN (ANALYZE) EXECUTE p"])(
		"rates %j by the statement the file prepared",
		(sql) => {
			const prepare = "PREPARE p AS WITH d AS (DELETE FROM t RETURNING id) SELECT id FROM d"
			const [line] = rate(`${prepare};\n${sql};`).unsafeStatements
			expect(line?.startsWith(`${sql} (`)).toBe(true)
			expect(line).toContain("deletes rows of t")
		},
	)
})

/** Why check refuses an EXECUTE of `name` that nothing before it in its file prepares */
const unprepared = (name: string) =>
	`no statement before it in its file prepares ${name}, and comb applies each file in a session of its own, so an earlier file's PREPARE never reaches it: Postgres fails the file with "prepared statement "${name}" does not exist"; PREPARE it in this file`

/* AE2-9 of r22: comb's apply runs one Atlas call per file (atlas-apply-runs.ts), so an EXECUTE runs
   only what its own file prepared, or what user code before it did: a refusal is as sound as a rating */
describe("an EXECUTE of a statement its file does not prepare (AE2-9 of r22)", () => {
	it.each([
		["EXECUTE nothere;", "EXECUTE nothere", "nothere"],
		["EXECUTE nothere(1);", "EXECUTE nothere(1)", "nothere"],
		["EXPLAIN ANALYZE EXECUTE nothere;", "EXPLAIN ANALYZE EXECUTE nothere", "nothere"],
		['EXECUTE "P";', 'EXECUTE "P"', "P"],
		["PREPARE q AS SELECT 1;\nEXECUTE p;", "EXECUTE p", "p"],
		/* Postgres looks the name up when the EXECUTE runs, so a PREPARE after it is too late */
		["EXECUTE p;\nPREPARE p AS SELECT 1;", "EXECUTE p", "p"],
		/* a function called after the EXECUTE runs after its lookup failed */
		["EXECUTE p;\nSELECT f();", "EXECUTE p", "p"],
		/* a prepared query runs only when an EXECUTE runs it */
		["PREPARE q AS SELECT f();\nEXECUTE p;", "EXECUTE p", "p"],
		/* a DEALLOCATE, a transaction statement, a SET and a SHOW run no user code */
		["DEALLOCATE q;\nBEGIN;\nSET search_path = public;\nSHOW search_path;\nEXECUTE p;", "EXECUTE p", "p"],
	])("refuses %j at check, past any approval", (sql, statement, name) => {
		expect(() => rate(sql)).toThrow(`${statement}: ${unprepared(name)}`)
		expect(() => rate(`-- comb:allow-unsafe: prepared elsewhere\n${sql}`)).toThrow(unprepared(name))
	})

	it.each([
		["DO $$ BEGIN EXECUTE 'PREPARE p AS SELECT 1'; END $$;\nEXECUTE p;", "a DO block"],
		["CALL make_p();\nEXECUTE p;", "a CALL of make_p"],
		["SELECT public.make_p();\nEXECUTE p;", "a call of public.make_p()"],
		["PREPARE q AS SELECT make_p();\nEXECUTE q;\nEXECUTE p;", "a call of make_p()"],
		["PREPARE q AS INSERT INTO t VALUES (1);\nEXECUTE q;\nEXECUTE p;", "an EXECUTE of q"],
		["INSERT INTO t VALUES (1);\nEXECUTE p;", "user code an INSERT runs"],
		["SELECT 1;\nEXECUTE p;", "user code a SELECT runs"],
		["CREATE TABLE y (id int);\nEXECUTE p;", "an event trigger a CREATE TABLE fires"],
		["GRANT SELECT ON t TO PUBLIC;\nEXECUTE p;", "an event trigger a GRANT fires"],
		/* ddl_command_start fires before the CREATE TABLE AS runs its EXECUTE */
		["CREATE TABLE x AS EXECUTE p;", "an event trigger a CREATE TABLE AS fires"],
	])("rates %j, whose user code may prepare it, unsafe and names that code", (sql, dynamic) => {
		expect(rate(sql).unsafeStatements.map((line) => line.replace(/^CREATE TABLE x AS /, ""))).toContain(
			`EXECUTE p (runs a prepared statement comb cannot read, which ${dynamic} before it may prepare; approve it in the file)`,
		)
	})
})
