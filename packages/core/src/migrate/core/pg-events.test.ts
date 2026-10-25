import { beforeAll, describe, expect, it } from "vitest"
import { eventFindings, tagOf } from "./pg-events.ts"
import { historyFacts } from "./pg-history.ts"
import type { Node } from "./pg-nodes.ts"
import { loadPostgresParser, postgresParser } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

beforeAll(() => loadPostgresParser())

/** The command tag of `sql`'s first statement */
function tag(sql: string): string | undefined {
	const [first] = postgresParser().parseSync(sql).stmts as Array<{ stmt: Node }>
	const [type, node] = Object.entries((first as { stmt: Node }).stmt)[0] as [string, Node]
	return tagOf(type, node)
}

/** The event trigger findings `later` gets after `history` */
const findings = (history: string, later: string) =>
	eventFindings(postgresParser().parseSync(later).stmts, {
		facts: historyFacts(extractSchema(history, undefined, "postgres"), "public"),
	})

describe("tagOf: a statement's command tag, as an event trigger's WHEN TAG names it", () => {
	it("tags what a node type is, and an object's statement by the object", () => {
		expect(
			[
				"CREATE TABLE t (a int)",
				"CREATE INDEX i ON t (a)",
				"CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
				"CREATE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$",
				"CREATE TABLE q AS SELECT 1",
				"CREATE MATERIALIZED VIEW m AS SELECT 1",
				"SELECT 1 INTO r",
				"GRANT SELECT ON t TO u",
				"REVOKE SELECT ON t FROM u",
				"CREATE AGGREGATE g (int) (sfunc = int4pl, stype = int)",
			].map(tag),
		).toEqual([
			"CREATE TABLE",
			"CREATE INDEX",
			"CREATE FUNCTION",
			"CREATE PROCEDURE",
			"CREATE TABLE AS",
			"CREATE MATERIALIZED VIEW",
			"SELECT INTO",
			"GRANT",
			"REVOKE",
			"CREATE AGGREGATE",
		])
	})
})

describe("tagOf: the statements named by their object", () => {
	it("tags an ALTER, a DROP, a rename, a move and an owner by the object they name", () => {
		expect(
			[
				"ALTER INDEX i SET (fillfactor = 70)",
				"DROP MATERIALIZED VIEW m",
				"ALTER TABLE t RENAME COLUMN a TO b",
				"ALTER TABLE t RENAME CONSTRAINT c TO d",
				"ALTER SEQUENCE s SET SCHEMA x",
				"ALTER FUNCTION f() STABLE",
				"ALTER TYPE e OWNER TO u",
			].map(tag),
		).toEqual([
			"ALTER INDEX",
			"DROP MATERIALIZED VIEW",
			"ALTER TABLE",
			"ALTER TABLE",
			"ALTER SEQUENCE",
			"ALTER FUNCTION",
			"ALTER TYPE",
		])
	})

	it("tags no DML, shared object or event trigger statement, and an unnamed DDL as unknown", () => {
		for (const sql of [
			"SELECT 1",
			"INSERT INTO t VALUES (1)",
			"CREATE DATABASE d",
			"DROP EVENT TRIGGER e",
			"ALTER EVENT TRIGGER e RENAME TO e2",
		])
			expect(tag(sql), sql).toBeUndefined()
		expect(tag("CREATE PUBLICATION p FOR ALL TABLES")).toBe("?")
	})
})

describe("eventFindings: the event triggers a statement fires", () => {
	const SQL_DROP = "CREATE EVENT TRIGGER e ON sql_drop EXECUTE FUNCTION f();"

	it("fires sql_drop on DROP OWNED and a domain's dropped constraint, not on its added one", () => {
		expect(findings(SQL_DROP, "DROP OWNED BY u")).toHaveLength(1)
		expect(findings(SQL_DROP, "ALTER DOMAIN d DROP CONSTRAINT c")).toHaveLength(1)
		expect(findings(SQL_DROP, "ALTER DOMAIN d ADD CHECK (VALUE > 0)")).toEqual([])
		expect(findings(SQL_DROP, "DROP EVENT TRIGGER x")).toEqual([])
	})

	it("fires a tag-filtered trigger on DDL comb cannot tag, and nothing on an empty statement", () => {
		const tagged = "CREATE EVENT TRIGGER e ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION f();"
		expect(findings(tagged, "CREATE PUBLICATION p FOR ALL TABLES")).toHaveLength(1)
		expect(findings(tagged, "-- nothing")).toEqual([])
		const rewriting = "CREATE EVENT TRIGGER e ON table_rewrite EXECUTE FUNCTION f();"
		expect(findings(rewriting, "INSERT INTO t VALUES (1)")).toEqual([])
	})

	it("ignores an ALTER or a rename of a trigger the history never made", () => {
		const history = `${SQL_DROP} ALTER EVENT TRIGGER x DISABLE; ALTER EVENT TRIGGER x RENAME TO y;`
		expect(findings(history, "DROP TABLE t")).toEqual([
			{ level: "unsafe", note: "runs event trigger e, whose function comb does not read" },
		])
	})
})
