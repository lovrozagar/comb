import { beforeAll, describe, expect, it } from "vitest"
import { COMMAND_SAMPLES, NODE_SAMPLES, SETUP } from "../__fixtures__/inert-statements.ts"
import { nodeOf } from "./pg-outside-transaction.ts"
import { loadPostgresParser, postgresParser } from "./pg-parser.ts"
import { INERT, makesCompared, TABLE_COMMANDS } from "./pg-replay-gate.ts"

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
		/* P3 of r20: it fails closed, a node or command it has not proved inert counting */
		["CREATE TABLE t (id serial PRIMARY KEY);\nALTER SEQUENCE t_id_seq OWNED BY NONE", true],
		["ALTER SEQUENCE t_id_seq OWNED BY t.id", false],
		["ALTER TABLE t OWNER TO app", true],
		["ALTER TABLE t ENABLE TRIGGER ALL", true],
		["CREATE SCHEMA s CREATE VIEW v AS SELECT 1", true],
		["CREATE MATERIALIZED VIEW m AS SELECT 1", true],
		["CREATE TEXT SEARCH DICTIONARY d (TEMPLATE = simple)", true],
		["CREATE STATISTICS s ON a, b FROM t", true],
		["CREATE TABLE t (id int);\nCREATE TABEL u (id int)", true],
	])("reads %j as making something compared: %s", (sql, want) => {
		expect(makesCompared(file(sql))).toBe(want)
	})
})

/*
 * P3 of r20: each entry of the inert list has a statement in __fixtures__/inert-statements.ts, which
 * tests/integration/postgres/replay-gate.test.ts runs on Postgres, reading the catalog after
 */
/** The node of `sql`'s one statement: its type and fields */
const parsed = (sql: string) => nodeOf(postgresParser().parseSync(sql).stmts)

describe("makesCompared's inert list, each entry with its proof", () => {
	it("has a statement for each inert node and ALTER TABLE command, and none beside them", () => {
		expect(Object.keys(NODE_SAMPLES).sort()).toEqual([...INERT.keys()].sort())
		expect(Object.keys(COMMAND_SAMPLES).sort()).toEqual([...TABLE_COMMANDS].sort())
	})

	it.each(Object.entries(NODE_SAMPLES))("reads its %s, %j, as that node and inert", (node, sql) => {
		expect(parsed(sql)[0]).toBe(node)
		expect(makesCompared(file([...SETUP, sql].join(";\n")))).toBe(false)
	})

	it.each(Object.entries(COMMAND_SAMPLES))("reads its %s, %j, as that command and inert", (subtype, sql) => {
		const [type, node] = parsed(sql)
		const cmds = node["cmds"] as Array<{ AlterTableCmd: { subtype: string } }>
		expect([type, ...cmds.map(({ AlterTableCmd }) => AlterTableCmd.subtype)]).toEqual(["AlterTableStmt", subtype])
		expect(makesCompared(file(sql))).toBe(false)
	})
})
