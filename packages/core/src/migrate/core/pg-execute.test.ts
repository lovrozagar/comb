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

	it("rates an EXECUTE inside a CREATE TABLE AS whose statement comb cannot read unsafe", () => {
		expect(rated("CREATE TABLE x AS EXECUTE nothere;")).toEqual({
			cautiousStatements: [],
			safety: "unsafe",
			unsafeStatements: [
				"CREATE TABLE x AS EXECUTE nothere (runs a prepared statement comb cannot read; approve it in the file)",
			],
		})
	})

	it.each(["EXECUTE nothere;", "EXECUTE nothere(1);"])(
		"rates %j, whose statement an earlier file or session prepared, unsafe",
		(sql) => {
			expect(rated(sql)).toEqual({
				cautiousStatements: [],
				safety: "unsafe",
				unsafeStatements: [`${sql.slice(0, -1)} (runs a prepared statement comb cannot read; approve it in the file)`],
			})
		},
	)
})
