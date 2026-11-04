/**
 * comb-9d's per-table ruling on PA1 of r22b: a statement on rows ends its run only where a relation
 * it names holds code, as the files hold it (pg-session-tables.ts), a flag carried to a view reading
 * the table, a parent, a table a cascading key references, and across a rename.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { loadPostgresParser } from "./pg-parser.ts"
import { sessionRuns } from "./pg-session.ts"
import { pgRead } from "./pg-split.ts"

beforeAll(loadPostgresParser)

const T = "CREATE TABLE t (id int);\n"

/** The runs of the files `sqls`, by their names a, b, c…; `context` adds files that only define */
const runs = (sqls: readonly string[], context: readonly string[] = []): string[][] => {
	const files = sqls.map((sql, i) => ({ name: String.fromCharCode(97 + i), read: pgRead(sql) }))
	return sessionRuns(files, [...files, ...context.map((sql) => ({ read: pgRead(sql) }))]).map((run) =>
		run.map((file) => file.name),
	)
}

/** Whether a file of `sql` between two plain ones ends its run */
const ends = (sql: string, context: readonly string[] = []): boolean => runs([T, sql, T], context).length === 2

const TRIGGER_ON_A = [
	"CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE b (id int);\n",
	"CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\n",
	"CREATE TRIGGER x BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION touch();\n",
]

describe("the relations that hold code a statement on their rows runs", () => {
	it("keeps files that touch only b in one run beside a trigger on a, and ends one at a write to a", () => {
		const onB = ["INSERT INTO b VALUES (1);\n", "UPDATE b SET id = 2;\n", "DELETE FROM b;\n"]
		expect([
			runs(onB, TRIGGER_ON_A),
			runs([...onB.slice(0, 1), "INSERT INTO a VALUES (1);\n", ...onB.slice(1)], TRIGGER_ON_A),
		]).toEqual([
			[["a", "b", "c"]],
			[
				["a", "b"],
				["c", "d"],
			],
		])
	})

	it.each([
		["a rule", "CREATE RULE r AS ON INSERT TO t DO ALSO NOTIFY c;\n"],
		["a policy", "CREATE POLICY p ON t USING (true);\n"],
		["a default calling a function of its own", "CREATE TABLE t (id int DEFAULT public.op());\n"],
		[
			"a default calling one the files define",
			"CREATE FUNCTION op() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;\nCREATE TABLE t (id int DEFAULT op());\n",
		],
		["a generated column calling one", "ALTER TABLE t ADD COLUMN g int GENERATED ALWAYS AS (public.op(id)) STORED;\n"],
		["a check calling one", "ALTER TABLE t ADD CHECK (public.ok(id));\n"],
		["an index on an expression calling one", "CREATE INDEX i ON t ((public.op(id)));\n"],
		["a partial index whose predicate calls one", "CREATE INDEX i ON t (id) WHERE public.ok(id);\n"],
		["a view calling one", "CREATE VIEW t AS SELECT public.op() AS id;\n"],
	])("ends a run at a write to a table holding %s", (_, definition) => {
		expect(ends("INSERT INTO t VALUES (1);\n", [definition])).toBe(true)
	})

	it.each([
		["a default", "CREATE TABLE t (id int DEFAULT now(), at timestamptz DEFAULT pg_catalog.clock_timestamp());\n"],
		["a check", "CREATE TABLE t (id int CHECK (id > 0));\n"],
		[
			"a plpgsql function no table calls",
			"CREATE FUNCTION op() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;\n",
		],
	])("keeps a write to a table holding %s that calls only pg_catalog's functions", (_, definition) => {
		expect(ends("INSERT INTO t VALUES (1);\n", [definition])).toBe(false)
	})
})

describe("the relations a flag carries to", () => {
	it("ends a run at a delete from the table a cascading key into a trigger's table references, and not for a key that only checks", () => {
		const cascade = [
			"CREATE TABLE b (id int, a int REFERENCES a ON DELETE CASCADE);\nCREATE TABLE c (a int REFERENCES p);\n",
			"CREATE TRIGGER y AFTER DELETE ON b FOR EACH ROW EXECUTE FUNCTION f();\nCREATE TRIGGER z AFTER DELETE ON c FOR EACH ROW EXECUTE FUNCTION f();\n",
		]
		expect([ends("DELETE FROM a;\n", cascade), ends("DELETE FROM p;\n", cascade)]).toEqual([true, false])
	})

	it.each([
		{
			carry: "CREATE TABLE q (id int) PARTITION BY RANGE (id);\nCREATE TABLE p PARTITION OF q DEFAULT;\n",
			held: "p",
			statement: "INSERT INTO q VALUES (1);\n",
			to: "a partition's parent",
		},
		{
			carry: "ALTER TABLE q ATTACH PARTITION p DEFAULT;\n",
			held: "p",
			statement: "INSERT INTO q VALUES (1);\n",
			to: "a parent a partition is attached to",
		},
		{
			carry: "CREATE TABLE k () INHERITS (q);\n",
			held: "k",
			statement: "UPDATE q SET id = 1;\n",
			to: "a child's parent",
		},
		{
			carry: "ALTER TABLE k INHERIT q;\n",
			held: "k",
			statement: "UPDATE q SET id = 1;\n",
			to: "a child added to a parent",
		},
		{
			carry: "CREATE VIEW v AS SELECT * FROM r;\n",
			held: "r",
			statement: "SELECT * FROM v;\n",
			to: "a view of the table",
		},
		{
			carry: "CREATE MATERIALIZED VIEW m AS SELECT * FROM r;\n",
			held: "r",
			statement: "REFRESH MATERIALIZED VIEW m;\n",
			to: "a materialized view of the table",
		},
		{
			carry: "ALTER TABLE r RENAME TO r2;\n",
			held: "r",
			statement: "INSERT INTO r2 VALUES (1);\n",
			to: "a renamed table",
		},
	])("carries a trigger's flag to $to", ({ carry, held, statement }) => {
		const trigger = `CREATE TRIGGER x BEFORE INSERT ON ${held} FOR EACH ROW EXECUTE FUNCTION f();\n`
		expect([ends(statement, [carry, trigger]), ends(statement, [carry])]).toEqual([true, false])
	})
})

describe("the statements on rows that name no relation, and the relations a schema's statements make", () => {
	it("ends a run at a statement on rows that names no relation once any holds code, and not at a SELECT", () => {
		const trigger = ["CREATE TRIGGER x BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();\n"]
		expect([ends("VACUUM;\n", trigger), ends("SELECT 1;\n", trigger), ends("VACUUM;\n")]).toEqual([true, false, false])
	})

	it("reads a table a schema's own statement makes, and a trigger a schema's own statement holds", () => {
		const schema = [
			"CREATE SCHEMA s CREATE TABLE a (id int) CREATE TRIGGER x BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();\n",
		]
		expect([ends("INSERT INTO s.a VALUES (1);\n", schema), ends("INSERT INTO s.b VALUES (1);\n", schema)]).toEqual([
			true,
			false,
		])
	})

	it("ends every file's run once the files define an event trigger anywhere, whatever each touches", () => {
		const event = "CREATE EVENT TRIGGER e ON ddl_command_end EXECUTE FUNCTION f();\n"
		expect(
			runs(["INSERT INTO b VALUES (1);\n", "CREATE TABLE z (id int);\n", "SELECT 1;\n"], [...TRIGGER_ON_A, event]),
		).toEqual([["a"], ["b"], ["c"]])
	})
})
