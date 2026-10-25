import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { historyFacts } from "./pg-history.ts"
import { extractSchema } from "./schema.ts"

const facts = (sql: string) => historyFacts(extractSchema(sql, undefined, "postgres"), "public")

/* T5 and T6 of the 2.3 review: what the history attached to its tables, read from its parse trees */
describe("what a Postgres history attached to its tables", () => {
	it("reads nothing without a history", () => {
		expect(historyFacts(undefined, "public").code).toEqual(new Map())
	})

	it("fails on a statement Postgres cannot parse, since the facts after it are unknown (M75)", () => {
		expect(() => facts("CREATE TABL broken;\nCREATE TABLE t (id int DEFAULT f());")).toThrow(
			'comb could not read the history: "CREATE TABL broken" (syntax error at or near "TABL")',
		)
	})

	it("gives each reader its own copy", () => {
		const schema = extractSchema("CREATE TABLE t (id int DEFAULT f());", undefined, "postgres")
		historyFacts(schema, "public").code.clear()
		expect(historyFacts(schema, "public").code).toEqual(new Map([["t", "f"]]))
	})

	it("keeps the first code a table runs, and none for a pure default or a drop", () => {
		const read = facts(
			"CREATE TABLE t (id int DEFAULT f(), v int DEFAULT g());\nCREATE TABLE u (id int DEFAULT now());\nALTER TABLE u DROP COLUMN id;\nALTER TABLE t ALTER COLUMN v SET DEFAULT h();",
		)
		expect(read.code).toEqual(new Map([["t", "f"]]))
	})

	it("keeps the code a table's first clause runs over a later CHECK or ALTER", () => {
		expect(
			facts(
				"CREATE TABLE t (id int DEFAULT f(), CHECK (g() > 0), CHECK (id > 0));\nALTER TABLE t ADD CONSTRAINT c CHECK (h() > 0);",
			).code,
		).toEqual(new Map([["t", "f"]]))
		expect(facts("CREATE TABLE u (id int, CHECK (g() > 0));").code).toEqual(new Map([["u", "g"]]))
		expect(facts("CREATE TABLE v (id int);\nALTER TABLE v ALTER COLUMN id SET DEFAULT 0;").code).toEqual(new Map())
		expect(facts("CREATE TABLE w (id int);\nALTER TABLE w ALTER COLUMN id SET DEFAULT f();").code).toEqual(
			new Map([["w", "f"]]),
		)
	})
})

describe("what a Postgres history's parents, casts, operators and domains are", () => {
	it("records parents by partition and by inheritance, in other schemas too", () => {
		const read = facts(
			"CREATE TABLE p (id int) PARTITION BY RANGE (id);\nCREATE TABLE s.c PARTITION OF p FOR VALUES FROM (0) TO (1);\nCREATE TABLE i (id int);\nCREATE TABLE j () INHERITS (i);\nCREATE TABLE k (id int);\nALTER TABLE k INHERIT i;\nCREATE TABLE a (id int);\nALTER TABLE p ATTACH PARTITION a FOR VALUES FROM (1) TO (2);",
		)
		expect(read.parents).toEqual(
			new Map([
				["s.c", [{ parent: "p", partition: true }]],
				["j", [{ parent: "i", partition: false }]],
				["k", [{ parent: "i", partition: false }]],
				["a", [{ parent: "p", partition: true }]],
			]),
		)
	})

	it("reads a cast's function, and marks a table only for an implicit or assignment one", () => {
		const read = facts(
			"CREATE TABLE t (m mt, n nt, o ot);\nCREATE CAST (int AS mt) WITH FUNCTION tomt(int);\nCREATE CAST (int AS nt) WITH FUNCTION tont(int) AS ASSIGNMENT;\nCREATE CAST (int AS ot) WITHOUT FUNCTION AS IMPLICIT;",
		)
		expect(read.casts).toEqual(
			new Map([
				["mt", { automatic: false, fn: "tomt" }],
				["nt", { automatic: true, fn: "tont" }],
			]),
		)
		expect(read.code).toEqual(new Map([["t", "tont"]]))
	})

	it("reads an operator's function, named FUNCTION or PROCEDURE", () => {
		expect(facts("CREATE OPERATOR ## (PROCEDURE = hh, LEFTARG = int, RIGHTARG = int);").operators).toEqual(
			new Map([["##", "hh"]]),
		)
	})

	it("keeps a rule's table at the code it already ran", () => {
		expect(
			facts("CREATE TABLE t (id int DEFAULT f());\nCREATE RULE r AS ON INSERT TO t DO ALSO NOTHING;").code,
		).toEqual(new Map([["t", "f"]]))
	})

	it("reads a domain only when its CHECK calls a function", () => {
		expect(facts("CREATE DOMAIN plain AS int;").domains).toEqual(new Map())
		expect(facts("CREATE DOMAIN pos AS int CHECK (VALUE > 0);").domains).toEqual(new Map())
		expect(facts("CREATE DOMAIN pos AS int CHECK (VALUE > f());").domains).toEqual(new Map([["pos", "f"]]))
	})
})

/* M25–M28 of the 0.13 review: what the history defined, read from its parse trees, however it was spelled or moved */
const WIPE =
	"CREATE TABLE users (id int);\nCREATE TABLE victim (id int);\nCREATE FUNCTION wipe() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN DELETE FROM victim; RETURN NEW; END$$;\n"
const later = (history: string, file: string) => {
	const rated = classifyMigration(file, { before: extractSchema(history, undefined, "postgres"), dialect: "postgres" })
	return { notes: [...rated.unsafeStatements, ...rated.cautiousStatements].join("\n"), safety: rated.safety }
}

const fn = (name: string, arg = "int") =>
	`CREATE FUNCTION ${name}(${arg}) RETURNS int LANGUAGE sql AS 'DELETE FROM victim RETURNING 1';\n`
const op = (name: string) =>
	`${WIPE}CREATE FUNCTION evil_eq(int, int) RETURNS boolean LANGUAGE sql AS 'DELETE FROM victim RETURNING true';\nCREATE OPERATOR ${name} (LEFTARG = int, RIGHTARG = int, FUNCTION = evil_eq);`

describe("a Postgres history's triggers, however the table was named or moved (M25)", () => {
	it.each([
		["ON users", "CREATE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION wipe();", "users"],
		[
			"a Unicode-escaped name",
			'CREATE TRIGGER t AFTER INSERT ON U&"\\0075sers" FOR EACH ROW EXECUTE FUNCTION wipe();',
			"users",
		],
		[
			"a rename with IF EXISTS",
			"CREATE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION wipe();\nALTER TABLE IF EXISTS users RENAME TO members;",
			"members",
		],
		[
			"a rename with ONLY",
			"CREATE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION wipe();\nALTER TABLE ONLY users RENAME TO members;",
			"members",
		],
		[
			"a move to another schema",
			"CREATE SCHEMA app;\nCREATE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION wipe();\nALTER TABLE users SET SCHEMA app;",
			"app.users",
		],
	])("names the trigger an insert fires after %s", (_label, history, table) => {
		expect(later(`${WIPE}${history}`, `INSERT INTO ${table} VALUES (1);`).notes).toContain("fires trigger t")
	})

	it("forgets a trigger once it is dropped, and one a renamed table took with it", () => {
		const trigger = "CREATE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION wipe();\n"
		expect(later(`${WIPE}${trigger}DROP TRIGGER t ON users;`, "INSERT INTO users VALUES (1);").notes).not.toContain(
			"fires trigger",
		)
		expect(
			later(`${WIPE}${trigger}ALTER TABLE users RENAME TO members;`, "INSERT INTO users VALUES (1);").notes,
		).not.toContain("fires trigger")
	})
})

describe("a Postgres history's functions, however named, renamed or dropped (M26, M28)", () => {
	it.each([
		["a Unicode-escaped name", fn('U&"\\006Cower"')],
		["a rename", `${fn("evil")}ALTER FUNCTION evil(int) RENAME TO lower;`],
		["one overload dropped of two", `${fn("lower")}${fn("lower", "bigint")}DROP FUNCTION lower(bigint);`],
		[
			"a move to another schema",
			`CREATE SCHEMA app;\n${fn("evil")}ALTER FUNCTION evil(int) SET SCHEMA app;\nALTER FUNCTION app.evil(int) RENAME TO lower;`,
		],
		["another schema, called bare through the search path", `CREATE SCHEMA app;\n${fn("app.lower")}`],
	])("calls lower a migration's function after %s", (_label, history) => {
		expect(later(`${WIPE}${history}`, "INSERT INTO users SELECT lower(5);").notes).toContain(
			"calls lower, a function a migration defined",
		)
	})

	it("calls an aggregate a migration defined its function", () => {
		const history = `${WIPE}CREATE FUNCTION pick(text, text, text) RETURNS text LANGUAGE sql AS 'SELECT $2';\nCREATE AGGREGATE count(text, text) (SFUNC = pick, STYPE = text);`
		expect(later(history, "INSERT INTO users SELECT count('a', 'b');").notes).toContain(
			"calls count, a function a migration defined",
		)
	})
})

describe("a Postgres history's operators, qualified or not (M27)", () => {
	it.each([
		["public.===", "INSERT INTO users SELECT 1 WHERE 1 === 1;"],
		["===", "INSERT INTO users SELECT 1 WHERE 1 OPERATOR(public.===) 1;"],
	])("names a use of %s", (name, file) => {
		expect(later(op(name), file).notes).toContain("uses operator ===, which a migration defined")
	})

	it("leaves an operator qualified by another schema to that schema", () => {
		expect(later(op("==="), "INSERT INTO users SELECT 1 WHERE 1 OPERATOR(app.===) 1;").notes).not.toContain(
			"uses operator",
		)
	})
})

describe("Postgres settings that change who later names resolve for (M28)", () => {
	it.each(["SET ROLE app;", "SET SESSION AUTHORIZATION app;", "RESET ROLE;", "RESET SESSION AUTHORIZATION;"])(
		"rates %s unsafe",
		(file) => {
			expect(later(WIPE, file).safety).toBe("unsafe")
		},
	)
})

/* M70 of the 0.13.0 round: the tables the history's trees made, with their columns, keyed as the parser names them */
describe("the tables a Postgres history made", () => {
	it("follows each table's columns through adds, drops, renames, queries and drops of the table", () => {
		const read = facts(`CREATE TABLE U&"\\0074" (Id int, b int);
ALTER TABLE t ADD COLUMN c int, DROP COLUMN b;
ALTER TABLE t RENAME COLUMN c TO d;
ALTER TABLE t RENAME COLUMN gone TO e;
CREATE TABLE q AS SELECT 1 AS x;
SELECT 1 AS y INTO r;
CREATE TABLE old (a int);
ALTER TABLE old RENAME TO kept;
CREATE TABLE dropped (a int);
DROP TABLE dropped;`)
		expect(read.tables).toEqual(
			new Map([
				["t", new Set(["id", "d"])],
				["q", new Set()],
				["r", new Set()],
				["kept", new Set(["a"])],
			]),
		)
	})
})
