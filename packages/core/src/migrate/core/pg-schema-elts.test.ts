import { describe, expect, it } from "vitest"
import { postgresParser } from "./pg-parser.ts"
import { qualifySchemaElements } from "./pg-schema-elts.ts"

/** The schema each relation `sql` names gets, by name, after qualifying its CREATE SCHEMA elements */
function schemas(sql: string): Array<[string, string | undefined]> {
	const { stmts } = postgresParser().parseSync(sql)
	qualifySchemaElements(stmts)
	const out: Array<[string, string | undefined]> = []
	JSON.stringify(stmts, (_key, value: unknown) => {
		const relation = value as { relname?: unknown; schemaname?: string }
		if (typeof relation?.relname === "string") out.push([relation.relname, relation.schemaname])
		return value
	})
	return out
}

describe("qualifySchemaElements: names inside CREATE SCHEMA elements, as Postgres resolves them (M74)", () => {
	it("puts what the elements create in the schema, and a name they reference there only when an element creates it", () => {
		expect(
			schemas(
				"CREATE SCHEMA s CREATE TABLE t (id int) CREATE SEQUENCE q CREATE VIEW v AS SELECT id FROM users CREATE VIEW w AS SELECT id FROM t CREATE INDEX i ON t (id) CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();",
			),
		).toEqual([
			["t", "s"],
			["q", "s"],
			["v", "s"],
			["users", undefined],
			["w", "s"],
			["t", "s"],
			["t", "s"],
			["t", "s"],
		])
	})

	it("names the schema after its owner when it has no name of its own, and leaves a written schema as written", () => {
		expect(schemas("CREATE SCHEMA AUTHORIZATION bob CREATE TABLE t (id int);")).toEqual([["t", "bob"]])
		expect(schemas("CREATE SCHEMA s CREATE VIEW v AS SELECT id FROM other.t CREATE TABLE t (id int);")).toEqual([
			["v", "s"],
			["t", "other"],
			["t", "s"],
		])
	})

	it("leaves every other statement, and a CREATE SCHEMA with no elements, as parsed", () => {
		expect(schemas("CREATE SCHEMA s; INSERT INTO t VALUES (1);")).toEqual([["t", undefined]])
		expect(() => qualifySchemaElements(undefined)).not.toThrow()
	})
})
