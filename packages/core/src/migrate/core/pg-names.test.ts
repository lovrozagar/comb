import { describe, expect, it } from "vitest"
import { historyFacts } from "./pg-history.ts"
import { extractSchema } from "./schema.ts"

const facts = (sql: string) => historyFacts(extractSchema(sql, undefined, "postgres"), "public")
const ON = "CREATE TRIGGER t AFTER DELETE ON users FOR EACH ROW EXECUTE FUNCTION f();\n"

/* M25 and M26 of the 0.13 review: what a history names, followed through its parse trees */
describe("a Postgres history's triggers and routines, by name", () => {
	it("keeps a trigger's events, follows its rename and its table's rename, move and drop", () => {
		expect(facts(ON).triggers).toEqual(new Map([["users", [{ enabled: true, events: ["delete"], name: "t" }]]]))
		expect(facts(`${ON}ALTER TRIGGER t ON users RENAME TO u;`).triggers.get("users")).toEqual([
			{ enabled: true, events: ["delete"], name: "u" },
		])
		expect([...facts(`CREATE SCHEMA app;\n${ON}ALTER TABLE users SET SCHEMA app;`).triggers.keys()]).toEqual([
			"app.users",
		])
		expect([...facts(`${ON}ALTER TABLE users RENAME TO members;`).triggers.keys()]).toEqual(["members"])
		expect(facts(`${ON}DROP TABLE users;`).triggers).toEqual(new Map())
		expect(
			facts(`${ON}CREATE OR REPLACE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();`).triggers.get(
				"users",
			),
		).toEqual([{ enabled: true, events: ["insert"], name: "t" }])
	})

	it("moves what the history attached to a renamed table, and the tables that name it a parent", () => {
		const read = facts(
			"CREATE TABLE p (id int) PARTITION BY RANGE (id);\nCREATE TABLE c PARTITION OF p FOR VALUES FROM (1) TO (2);\nALTER TABLE p RENAME TO q;",
		)
		expect(read.parents.get("c")).toEqual([{ parent: "q", partition: true }])
		const other = facts(
			"CREATE TABLE p (id int) PARTITION BY RANGE (id);\nCREATE TABLE c PARTITION OF p FOR VALUES FROM (1) TO (2);\nCREATE SCHEMA app;\nCREATE TABLE app.x (id int);\nALTER TABLE app.x RENAME TO y;\nALTER TRIGGER gone ON y RENAME TO still;",
		)
		expect(other.parents.get("c")).toEqual([{ parent: "p", partition: true }])
		expect(other.triggers).toEqual(new Map())
	})

	it("keys a schema's table renamed in place by its schema, and renames only the trigger named", () => {
		const read = facts(
			`CREATE SCHEMA app;\nCREATE TRIGGER t AFTER DELETE ON app.users FOR EACH ROW EXECUTE FUNCTION f();\nCREATE TRIGGER v AFTER DELETE ON app.users FOR EACH ROW EXECUTE FUNCTION f();\nALTER TRIGGER t ON app.users RENAME TO u;\nALTER TABLE app.users RENAME TO members;`,
		)
		expect(read.triggers).toEqual(
			new Map([
				[
					"app.members",
					[
						{ enabled: true, events: ["delete"], name: "u" },
						{ enabled: true, events: ["delete"], name: "v" },
					],
				],
			]),
		)
	})

	it("defines a routine under each name it had: renamed, moved, an aggregate, a procedure", () => {
		const read = facts(
			"CREATE FUNCTION f(int) RETURNS int LANGUAGE sql AS 'SELECT 1';\nALTER FUNCTION f(int) RENAME TO g;\nALTER FUNCTION g(int) SET SCHEMA app;\nCREATE PROCEDURE p() LANGUAGE sql AS 'SELECT 1';\nALTER PROCEDURE p() RENAME TO q;\nCREATE AGGREGATE agg(int) (SFUNC = int4pl, STYPE = int);",
		)
		expect([...read.defined]).toEqual(["f", "g", "app.g", "p", "q", "agg"])
	})

	it("leaves a rename or move of anything else alone", () => {
		expect(facts("ALTER INDEX i RENAME TO j;\nALTER TYPE t SET SCHEMA app;\nDROP INDEX i;").defined).toEqual(new Set())
	})
})

describe("a Postgres history's names under a renamed schema", () => {
	/* M74 of the 0.13.0 review: a schema's rename takes everything named under it along */
	it("moves every table and routine of a renamed schema to the new name, triggers and all", () => {
		const read = facts(
			"CREATE SCHEMA app;\nCREATE TABLE app.users (id int);\nCREATE TRIGGER t AFTER INSERT ON app.users FOR EACH ROW EXECUTE FUNCTION f();\nCREATE TABLE app.p (id int) PARTITION BY RANGE (id);\nCREATE TABLE app.c PARTITION OF app.p FOR VALUES FROM (1) TO (2);\nCREATE FUNCTION app.g(int) RETURNS int LANGUAGE sql AS 'SELECT 1';\nCREATE TRIGGER k AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();\nALTER SCHEMA app RENAME TO app2;",
		)
		expect([...read.triggers.keys()].toSorted()).toEqual(["app2.users", "users"])
		expect(read.parents.get("app2.c")).toEqual([{ parent: "app2.p", partition: true }])
		expect([...read.parents.keys()]).toEqual(["app2.c"])
		expect(read.defined).toEqual(new Set(["app.g", "app2.g"]))
		const code = facts(
			"CREATE SCHEMA app;\nCREATE FUNCTION app.f(int) RETURNS boolean LANGUAGE sql AS 'SELECT true';\nCREATE DOMAIN app.d AS int CHECK (app.f(VALUE));\nCREATE OPERATOR app.=== (LEFTARG = int, RIGHTARG = int, FUNCTION = app.f2);\nCREATE TYPE app.t AS (x int);\nCREATE CAST (app.t AS int) WITH FUNCTION app.tf(app.t) AS IMPLICIT;\nALTER SCHEMA app RENAME TO app2;",
		)
		expect(code.domains).toEqual(new Map([["app2.d", "app2.f"]]))
		expect(code.operators).toEqual(new Map([["app2.===", "app2.f2"]]))
		expect(code.casts).toEqual(new Map([["int4", { automatic: true, fn: "app2.tf" }]]))
	})

	it("moves public's tables when public is renamed, and keys a schema renamed to public as unqualified", () => {
		expect([...facts(`${ON}ALTER SCHEMA public RENAME TO old;`).triggers.keys()]).toEqual(["old.users"])
		expect([
			...facts(
				"CREATE SCHEMA app;\nCREATE TRIGGER t AFTER DELETE ON app.users FOR EACH ROW EXECUTE FUNCTION f();\nALTER SCHEMA app RENAME TO public;",
			).triggers.keys(),
		]).toEqual(["users"])
	})
})
