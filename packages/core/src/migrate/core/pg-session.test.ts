/**
 * PA1 of r22b: the files that may share one session, each run ending at the first file that may
 * change it. A run's files then behave as each would alone, as only the last can leave the session
 * changed for the next run, which starts on a session of its own.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { loadPostgresParser } from "./pg-parser.ts"
import { NO_SERVER_CODE, type ServerCode } from "./pg-server-code.ts"
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

describe("the files that may share one session (PA1 of r22b)", () => {
	it("runs files that leave the session as they found it in one run", () => {
		expect(runs([T, "CREATE INDEX i ON t (id);\n", "INSERT INTO t VALUES (1);\n"])).toEqual([["a", "b", "c"]])
	})

	it.each([
		["a SET", "SET lock_timeout = 0;\n"],
		["a RESET", "RESET statement_timeout;\n"],
		["a RESET ALL", "RESET ALL;\n"],
		["a SET ROLE", "SET ROLE app;\n"],
		["a SET SESSION AUTHORIZATION", "SET SESSION AUTHORIZATION app;\n"],
		["SET SESSION CHARACTERISTICS", "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;\n"],
		["a set_config for the session", "SELECT set_config('search_path', 'x', false);\n"],
		["a set_config whose third argument is not a literal", "SELECT set_config('a.b', 'x', 1 = 1);\n"],
		["a set_config qualified", "SELECT pg_catalog.set_config('a.b', 'x', false);\n"],
		["a DO block", "DO $$ BEGIN PERFORM 1; END $$;\n"],
		["a CALL", "CALL p();\n"],
		["a DISCARD", "DISCARD PLANS;\n"],
		["a PREPARE", "PREPARE q AS SELECT 1;\n"],
		["a LISTEN", "LISTEN c;\n"],
		["a LOAD", "LOAD 'auto_explain';\n"],
		["a cursor held past its transaction", "DECLARE c CURSOR WITH HOLD FOR SELECT 1;\n"],
		["a temp table", "CREATE TEMP TABLE x (id int);\n"],
		["a table in pg_temp", "CREATE TABLE pg_temp.x (id int);\n"],
		["a temp view", "CREATE TEMP VIEW v AS SELECT 1;\n"],
		["a temp sequence", "CREATE TEMP SEQUENCE s;\n"],
		["a temp table as a query", "CREATE TEMP TABLE x AS SELECT 1;\n"],
		["an extension", "CREATE EXTENSION citext;\n"],
		["a call of a function comb does not know", "SELECT uuid_generate_v4();\n"],
		["a call of a pg_catalog function comb does not list", "SELECT pg_advisory_lock(1);\n"],
		["a schema-qualified call of an unknown function", "SELECT app.f();\n"],
		["a call in an ALTER TABLE's new column default, run on its rows", "ALTER TABLE t ADD COLUMN c int DEFAULT f();\n"],
		["a statement the parser cannot read", "CREATE TABL x (id int);\n"],
	])("ends a run after %s", (_, sql) => {
		expect(ends(sql)).toBe(true)
	})

	it.each([
		["SET LOCAL", "SET LOCAL lock_timeout = 0;\n"],
		["SET TRANSACTION", "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;\n"],
		["set_config(…, true)", "SELECT set_config('a.b', 'x', true);\n"],
		["a listed pg_catalog call", "UPDATE t SET id = abs(id) WHERE now() > '2020-01-01';\n"],
		["a SQL-syntax call", "SELECT extract(year FROM now()), substring('ab' FROM 1);\n"],
		["a function's body", "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN SET x = 1; END $$;\n"],
		["a view's call", "CREATE VIEW v AS SELECT uuid_generate_v4();\n"],
		["a CREATE TABLE's default and check", "CREATE TABLE u (id int DEFAULT f() CHECK (g(id)));\n"],
		["an ALTER TABLE's SET DEFAULT, stored for later rows", "ALTER TABLE t ALTER COLUMN id SET DEFAULT f();\n"],
		["a materialized view made with no data", "CREATE MATERIALIZED VIEW m AS SELECT f() WITH NO DATA;\n"],
		["a nextval", "SELECT nextval('s');\n"],
	])("keeps %s in its run", (_, sql) => {
		expect(ends(sql)).toBe(false)
	})
})

describe("the calls a file's run is ended for (PA1 of r22b)", () => {
	it("keeps a call of a LANGUAGE sql function whose body leaves the session, qualified or not", () => {
		const f = "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT abs(1) $$;\n"
		const g = "CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT f(); END;\n"
		expect([ends("SELECT f();\n", [f]), ends("SELECT public.g();\n", [f, g])]).toEqual([false, false])
	})

	it("ends a run after a call of a LANGUAGE sql function whose body, or one it calls, sets the session", () => {
		const f = "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT set_config('a.b', 'x', false)::int $$;\n"
		const g = "CREATE FUNCTION g() RETURNS int LANGUAGE sql AS $$ SELECT f() $$;\n"
		expect([ends("SELECT f();\n", [f]), ends("SELECT g();\n", [f, g])]).toEqual([true, true])
	})

	it("ends a run after a call of a function that shadows a listed pg_catalog name", () => {
		expect(ends("SELECT lower('A');\n", ["CREATE FUNCTION lower(x text) RETURNS text LANGUAGE c AS 'x', 'y';\n"])).toBe(
			true,
		)
	})
})

describe("the stored code a file's run is ended for (PA1 of r22b)", () => {
	it("ends a run after a statement on rows once the files define a trigger's function, and not after DDL alone", () => {
		const trigger = [
			"CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\n",
			"CREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION touch();\n",
		]
		expect([
			ends("INSERT INTO t VALUES (1);\n", trigger),
			ends("ALTER TABLE t ADD COLUMN c int;\n", trigger),
			ends("ALTER TABLE t DROP COLUMN c, ALTER COLUMN id SET STORAGE PLAIN;\n", trigger),
			ends("CREATE TABLE u (id int);\nCREATE SCHEMA s CREATE TABLE v (id int);\n", trigger),
			ends("CREATE TABLE u PARTITION OF t DEFAULT;\n", trigger),
		]).toEqual([true, true, false, false, true])
	})

	it.each([
		["an operator", "CREATE OPERATOR === (FUNCTION = f, LEFTARG = int, RIGHTARG = int);\n"],
		["a cast", "CREATE CAST (int AS text) WITH FUNCTION f(int);\n"],
		["an extension", "CREATE EXTENSION citext;\n"],
		["an aggregate", "CREATE AGGREGATE total(int) (SFUNC = int4pl, STYPE = int);\n"],
		["a domain whose check calls a function of its own", "CREATE DOMAIN d AS int CHECK (public.f(VALUE));\n"],
	])(
		"ends a run at every statement on rows once the files define %s, which no statement names, and keeps DDL",
		(_, definition) => {
			expect([ends("UPDATE u SET id = 1;\n", [definition]), ends("CREATE TABLE u (id int);\n", [definition])]).toEqual([
				true,
				false,
			])
		},
	)

	it("keeps a statement on rows when the files define only a procedure, which runs at a CALL alone", () => {
		expect(ends("UPDATE t SET id = 1;\n", ["CREATE PROCEDURE p() LANGUAGE plpgsql AS $$ BEGIN END $$;\n"])).toBe(false)
	})

	it("ends every file's run once the files define an event trigger, which runs on DDL", () => {
		const event = "CREATE EVENT TRIGGER e ON ddl_command_end EXECUTE FUNCTION f();\n"
		expect(runs([T, T, T], [event])).toEqual([["a"], ["b"], ["c"]])
	})
})

describe("a file that reads what the session holds (PA1 of r22b)", () => {
	it("starts a run at a file that reads what an earlier nextval left, and ends one at the file that changes", () => {
		expect(runs([T, "SELECT currval('s');\n", T, "SET x.y = 1;\n", T])).toEqual([["a"], ["b", "c", "d"], ["e"]])
		expect(runs(["SELECT lastval();\n", T])).toEqual([["a", "b"]])
	})

	it("reads a LANGUAGE sql function comb cannot parse, or one with no body, as one it cannot prove", () => {
		const bad = "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELEC 1 $$;\n"
		expect(ends("SELECT f();\n", [bad])).toBe(true)
	})
})

/** The runs of the files `sqls` beside a server holding `opaque` code and the definitions `held` */
const onServer = (sqls: readonly string[], server: Partial<ServerCode>, held: readonly string[] = []): string[][] => {
	const files = sqls.map((sql, i) => ({ name: String.fromCharCode(97 + i), read: pgRead(sql) }))
	const trees = held.flatMap((sql) => pgRead(sql).statements.map((statement) => statement.tree))
	return sessionRuns(files, files, { ...NO_SERVER_CODE, ...server, trees }).map((run) => run.map((file) => file.name))
}

describe("the code the server holds, which every file may run (comb-9d's ruling on PA1)", () => {
	it("gives each file a run of its own on a server holding an event trigger, which runs on DDL", () => {
		expect(onServer([T, "CREATE INDEX i ON t (id);\n", T], { events: true })).toEqual([["a"], ["b"], ["c"]])
	})

	it("ends a run at each statement on rows on a server holding code no statement names, and keeps DDL", () => {
		const files = [T, T, "INSERT INTO t VALUES (1);\n", T, "CREATE INDEX i ON t (id);\n", T]
		expect(onServer(files, { opaque: true })).toEqual([["a", "b", "c"], ["d", "e"], ["f"]])
	})

	/* the full split's bug: a plpgsql function the target holds split every file, as an event trigger would */
	it("batches 39 files of DDL and rows beside a function the server holds, ending a run only where a relation holding code is named", () => {
		const files = Array.from({ length: 39 }, (_, i) =>
			i === 20 ? "INSERT INTO t VALUES (1);\n" : `CREATE TABLE u${i} (id int);\nINSERT INTO u${i} VALUES (${i});\n`,
		)
		const lengths = onServer(files, { names: ["op"], tables: ["t"] }).map((run) => run.length)
		expect(lengths).toEqual([21, 18])
	})

	it("ends a run after a call of a LANGUAGE sql function the server holds that sets the session, and not before", () => {
		const sets = "CREATE FUNCTION public.f() RETURNS text LANGUAGE sql AS $$ SELECT set_config('a.b', 'x', false) $$;"
		expect(onServer([T, "SELECT f();\n", T], { names: ["f"] }, [sets])).toEqual([["a", "b"], ["c"]])
	})

	it("carries a flag the server holds along its pairs, a flag of the directory's along the server's", () => {
		const reaches: Array<readonly [string, string]> = [["child", "parent"]]
		expect([
			onServer([T, "DELETE FROM parent;\n", T], { reaches, tables: ["child"] }),
			onServer(
				[T, "DELETE FROM parent;\n", "CREATE TRIGGER x BEFORE INSERT ON child FOR EACH ROW EXECUTE FUNCTION f();\n"],
				{
					reaches,
				},
			),
		]).toEqual([
			[["a", "b"], ["c"]],
			[["a", "b"], ["c"]],
		])
	})

	it("proves a call to a LANGUAGE sql function the server holds, as one a file defines", () => {
		const plain = "CREATE FUNCTION public.g() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;"
		const calls = "CREATE TABLE u AS SELECT g() AS v;\n"
		expect([onServer([T, calls, T], { names: ["g"] }, [plain]), onServer([T, calls, T], { names: ["g"] })]).toEqual([
			[["a", "b", "c"]],
			[["a", "b"], ["c"]],
		])
	})
})
