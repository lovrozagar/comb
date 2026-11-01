import { beforeAll, describe, expect, it } from "vitest"
import { CATALOG } from "./pg-live-catalog.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { ARM_MAKERS, makesCompared, UNSEEN } from "./pg-replay-gate.ts"

beforeAll(loadPostgresParser)

const file = (sql: string) => [{ name: "1_a.sql", sql }]

/* R1 of stack 2: what the tree cannot see a statement make counts as making something compared, so the replay runs */
describe("makesCompared on what a statement makes out of the tree's sight", () => {
	it.each([
		"DO $$ BEGIN EXECUTE 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS ''select 1'''; END $$;",
		"CALL make_things();",
		"PREPARE p AS SELECT 1;\nEXECUTE p;",
		"CREATE FUNCTION mk() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'CREATE VIEW v AS SELECT 1'; END $$;\nSELECT mk();",
	])("reads %j as making something compared", (sql) => {
		expect(makesCompared(file(sql))).toBe(true)
	})

	it("reads a call of a function no history file defines, and a plain serial or identity table, as making nothing", () => {
		expect(makesCompared(file("SELECT pg_catalog.now();\nSELECT set_config('a.b', 'c', false);"))).toBe(false)
		expect(makesCompared(file("CREATE TABLE t (id serial PRIMARY KEY, n bigint GENERATED ALWAYS AS IDENTITY);"))).toBe(
			false,
		)
	})
})

describe("makesCompared", () => {
	it.each([
		["CREATE VIEW v AS SELECT 1", true],
		["CREATE TABLE t (id int);\nALTER TABLE t FORCE ROW LEVEL SECURITY", true],
		["CREATE SEQUENCE s", true],
		["CREATE TYPE mood AS RANGE (subtype = int4)", true],
		["CREATE TABLE t (id serial PRIMARY KEY);\nCREATE INDEX i ON t (id);\nALTER TABLE t ADD COLUMN b int", false],
		["CREATE TABLE t AS SELECT 1 AS a", false],
		/* P12 of r19: what the new arms read, and what Atlas compares itself, which the gate leaves to Atlas */
		["ALTER TABLE t REPLICA IDENTITY FULL", true],
		["ALTER VIEW v SET (security_invoker = true)", true],
		["CREATE OPERATOR @@@ (RIGHTARG = int, FUNCTION = f)", true],
		["CREATE AGGREGATE s(int) (SFUNC = add2, STYPE = int)", true],
		["ALTER TABLE t SET (fillfactor = 70)", false],
		["CREATE TEXT SEARCH CONFIGURATION ts (COPY = english)", false],
	])("reads %j as making something compared: %s", (sql, want) => {
		expect(makesCompared(file(sql))).toBe(want)
	})
})

/*
 * R1 of stack 2: the gate is held to the catalog read. Each arm the read has names the statements that make what it
 * reads, and each of those has a statement here that makes it, so an arm added to CATALOG without its gate fails
 */
describe("makesCompared's makers, held to CATALOG's arms", () => {
	// lookup-table: one statement per maker node, making what its arm reads
	const MADE_BY: Record<string, string> = {
		AlterFunctionStmt: "ALTER FUNCTION f(int) SECURITY DEFINER",
		AlterTableStmt: "ALTER TABLE t ENABLE ROW LEVEL SECURITY",
		CallStmt: "CALL p()",
		DefineStmt: "CREATE COLLATION c (provider = icu, locale = 'und')",
		CompositeTypeStmt: "CREATE TYPE c AS (a int)",
		CreateCastStmt: "CREATE CAST (pair AS int) WITH FUNCTION pi(pair)",
		CreateDomainStmt: "CREATE DOMAIN d AS int",
		CreateEventTrigStmt: "CREATE EVENT TRIGGER e ON ddl_command_start EXECUTE FUNCTION et()",
		CreateExtensionStmt: "CREATE EXTENSION citext",
		CreateFunctionStmt: "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1'",
		CreatePolicyStmt: "CREATE POLICY p ON t USING (true)",
		CreatePublicationStmt: "CREATE PUBLICATION pub FOR TABLE t",
		CreateRangeStmt: "CREATE TYPE r AS RANGE (subtype = int4)",
		CreateSeqStmt: "CREATE SEQUENCE s",
		CreateTableAsStmt: "CREATE MATERIALIZED VIEW m AS SELECT 1",
		CreateTrigStmt: "CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()",
		DoStmt: "DO $$ BEGIN NULL; END $$",
		ExecuteStmt: "EXECUTE p",
		RuleStmt: "CREATE RULE r AS ON INSERT TO t DO NOTHING",
		ViewStmt: "CREATE VIEW v AS SELECT 1",
	}

	it("gates every arm the catalog read has, and nothing it lacks; the connecting role is made by no statement", () => {
		const arms = new Set([...CATALOG.matchAll(/SELECT '([a-z]+)'/g)].map((match) => match[1] as string))
		expect([...arms].sort()).toEqual([...Object.keys(ARM_MAKERS), "user"].sort())
	})

	it.each(Object.entries(ARM_MAKERS).flatMap(([arm, makers]) => Object.keys(makers).map((node) => [arm, node])))(
		"has the %s arm's %s make it",
		(_, node) => {
			const sql = MADE_BY[node] as string
			expect([sql !== undefined && makesCompared(file(`${sql};`))]).toEqual([true])
		},
	)

	it.each([...UNSEEN])("counts %s, whose effect the tree cannot see", (node) => {
		expect(makesCompared(file(`${MADE_BY[node] as string};`))).toBe(true)
	})
})
