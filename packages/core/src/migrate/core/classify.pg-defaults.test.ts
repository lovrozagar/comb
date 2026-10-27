/**
 * M83 of the 0.13.0 round: a write runs the code its table's defaults call, so the history records
 * a call only when its finding is unsafe. A default's nextval, which is what a serial does, is no
 * such code, so an insert into its table is not unsafe for it; a default that calls a function a
 * migration defined still is.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

/** `later`'s rating after `history`, both read as Postgres */
function rate(history: string, later: string) {
	const before = extractSchema(history, undefined, "postgres")
	return classifyMigration(later, { before, dialect: "postgres" })
}

describe("a column default's calls, as a write runs them (M83)", () => {
	it("rates an insert into a table whose default calls nextval safe, as a serial's is", () => {
		const history = "CREATE SEQUENCE s; CREATE TABLE t (id bigint DEFAULT nextval('s'), v text);"
		expect(rate(history, "INSERT INTO t (v) VALUES ('x');").safety).toBe("safe")
	})

	it("keeps a default that calls a function a migration defined unsafe, and an explicit nextval cautious", () => {
		const defined =
			"CREATE FUNCTION f() RETURNS bigint LANGUAGE sql AS 'SELECT 1'; CREATE TABLE t (id bigint DEFAULT f(), v text);"
		expect(rate(defined, "INSERT INTO t (v) VALUES ('x');").unsafeStatements.join(" ")).toContain("runs f")
		const explicit = rate(
			"CREATE SEQUENCE s; CREATE TABLE t (id bigint, v text);",
			"INSERT INTO t VALUES (nextval('s'), 'x');",
		)
		expect(explicit.safety).toBe("cautious")
	})

	it("keeps a default that calls a function neither built in nor the history's, an extension's say, unsafe", () => {
		const unknown = "CREATE TABLE t (id bigint DEFAULT ext_fn(), v text);"
		expect(rate(unknown, "INSERT INTO t (v) VALUES ('x');").unsafeStatements.join(" ")).toContain("runs ext_fn")
	})
})
