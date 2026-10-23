import { describe, expect, it } from "vitest"
import { historyFacts } from "./pg-history.ts"
import { extractSchema } from "./schema.ts"

const facts = (sql: string) => historyFacts(extractSchema(sql, undefined, "postgres"))
const ON = "CREATE TRIGGER t AFTER DELETE ON users FOR EACH ROW EXECUTE FUNCTION f();\n"

/* M25 and M26 of the 0.13 review: what a history names, followed through its parse trees */
describe("a Postgres history's triggers and routines, by name", () => {
	it("keeps a trigger's events, follows its rename and its table's rename, move and drop", () => {
		expect(facts(ON).triggers).toEqual(new Map([["users", [{ events: ["delete"], name: "t" }]]]))
		expect(facts(`${ON}ALTER TRIGGER t ON users RENAME TO u;`).triggers.get("users")).toEqual([
			{ events: ["delete"], name: "u" },
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
		).toEqual([{ events: ["insert"], name: "t" }])
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
						{ events: ["delete"], name: "u" },
						{ events: ["delete"], name: "v" },
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
