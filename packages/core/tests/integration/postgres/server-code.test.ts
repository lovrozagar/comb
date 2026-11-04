/**
 * comb-9d's rulings on PA1 of r22b, held to a real catalog: the code a database holds that a run of
 * files may run without naming it (pg-server-code.ts). An event trigger splits every file; code no
 * statement names (an extension past plpgsql, an operator, a cast, a type of its own) ends a run at
 * every statement on rows; and a relation holding code (a trigger, a rule, a policy, or a default,
 * check or index calling a function outside pg_catalog) ends one only where a statement names it,
 * a flag carried to a view reading it, a parent, and a table a cascading key references.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { loadPostgres } from "../../../src/migrate/core/pg-live-objects.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { targetCode } from "../../../src/migrate/core/pg-server-code.ts"
import { sessionRuns } from "../../../src/migrate/core/pg-session.ts"
import { pgRead } from "../../../src/migrate/core/pg-split.ts"
import { withScratchDb } from "../support/pg.ts"
import { query } from "../support/pg-roles.ts"

beforeAll(loadPostgresParser)

/** The code a scratch database holds once `made` ran in it, read as an apply reads its target's, and what `use` makes of it */
const held = <T>(made: string, use: (code: Awaited<ReturnType<typeof targetCode>>) => T) =>
	withScratchDb(async (url) => {
		if (made !== "") await query(url, made)
		const target = { devUrl: url, lockTimeout: "5s", schema: "public", url }
		return use(await targetCode(target, () => loadPostgres("read the code the test database holds")))
	})

/** The code's flags alone */
const flags = (code: Awaited<ReturnType<typeof targetCode>>) => ({
	events: code.events,
	opaque: code.opaque,
	tables: code.tables,
})

const OP = "CREATE FUNCTION op(int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN $1; END $$;"
const OK = "CREATE FUNCTION ok(int) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RETURN true; END $$;"

describe("the relations a database holds code on (comb-9d's rulings on PA1)", () => {
	it("holds none in a database with tables, keys, pg_catalog's defaults and checks, and an aggregate over Postgres's own functions", async () => {
		const made = `CREATE TABLE p (id int PRIMARY KEY, at timestamptz DEFAULT now() CHECK (at > '2000-01-01'));
CREATE TABLE c (p int REFERENCES p);
CREATE AGGREGATE total(int) (SFUNC = int4pl, STYPE = int);
${OP}`
		expect(await held(made, flags)).toEqual({ events: false, opaque: false, tables: [] })
	}, 60_000)

	it.each([
		[
			"a trigger, on Postgres's own function",
			"CREATE TABLE t (id int); CREATE TRIGGER s BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();",
		],
		["a rule", "CREATE TABLE t (id int); CREATE RULE r AS ON INSERT TO t DO ALSO NOTIFY c;"],
		["a policy", "CREATE TABLE t (id int); CREATE POLICY p ON t USING (true);"],
		["a default calling a function of its own", `${OP} CREATE TABLE t (id int DEFAULT op(1));`],
		[
			"a generated column calling one",
			`CREATE FUNCTION g(int) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$; CREATE TABLE t (id int, x int GENERATED ALWAYS AS (g(id)) STORED);`,
		],
		["a check calling one", `${OK} CREATE TABLE t (id int CHECK (ok(id)));`],
		[
			"an index on an expression calling one",
			`CREATE FUNCTION g(int) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$; CREATE TABLE t (id int); CREATE INDEX i ON t ((g(id)));`,
		],
		["a view calling one", `${OP} CREATE VIEW t AS SELECT op(1) AS id;`],
	])(
		"flags the one relation holding %s",
		async (_, made) => {
			expect(await held(made, flags)).toEqual({ events: false, opaque: false, tables: ["t"] })
		},
		60_000,
	)
})

describe("the flags a database's relations carry, and the runs of files they give", () => {
	it("carries a flag to a view reading the table, a partition's parent and the table a cascading key references, and not along a key that only checks", async () => {
		const made = `CREATE TABLE t (id int PRIMARY KEY);
CREATE TRIGGER s BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();
CREATE VIEW v AS SELECT * FROM t;
CREATE TABLE q (id int) PARTITION BY RANGE (id);
CREATE TABLE p PARTITION OF q DEFAULT;
CREATE TRIGGER s BEFORE UPDATE ON p FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();
CREATE TABLE a (id int PRIMARY KEY);
CREATE TABLE b (a int REFERENCES a ON DELETE CASCADE);
CREATE TRIGGER s BEFORE UPDATE ON b FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();
CREATE TABLE k (id int PRIMARY KEY);
CREATE TABLE l (k int REFERENCES k);
CREATE TRIGGER s BEFORE UPDATE ON l FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();`
		const tables = (files: readonly string[]) =>
			held(made, (code) => {
				const read = files.map((sql, i) => ({ i, read: pgRead(sql) }))
				return sessionRuns(read, read, code).map((run) => run.map((file) => file.i))
			})
		const at = (statement: string) => tables(["SELECT 1;\n", statement, "SELECT 1;\n"])
		expect([
			await at("SELECT * FROM v;\n"),
			await at("INSERT INTO q VALUES (1);\n"),
			await at("DELETE FROM a;\n"),
			await at("DELETE FROM k;\n"),
		]).toEqual([[[0, 1], [2]], [[0, 1], [2]], [[0, 1], [2]], [[0, 1, 2]]])
	}, 60_000)

	/* the full split's bug (pg-session.ts held code as an event trigger): a plpgsql function the target held split all 39 */
	it("batches 39 files of DDL and rows beside a plpgsql function and a trigger the target holds, ending a run only at the write to the trigger's table", async () => {
		const made = `${OP} CREATE TABLE t (id int); CREATE TRIGGER s BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();`
		const files = Array.from({ length: 39 }, (_, i) =>
			i === 20 ? "UPDATE t SET id = 1;\n" : `CREATE TABLE u${i} (id int);\nINSERT INTO u${i} VALUES (${i});\n`,
		)
		const lengths = await held(made, (code) => {
			const read = files.map((sql) => ({ read: pgRead(sql) }))
			return sessionRuns(read, read, code).map((run) => run.length)
		})
		expect(lengths).toEqual([21, 18])
	}, 60_000)
})

describe("the code a database holds that no statement names, and what else its read hands on", () => {
	it.each([
		["an extension past plpgsql", "CREATE EXTENSION citext;"],
		[
			"an operator of its own",
			`CREATE FUNCTION eq(int, int) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RETURN $1 = $2; END $$; CREATE OPERATOR === (FUNCTION = eq, LEFTARG = int, RIGHTARG = int);`,
		],
		[
			"a cast of its own",
			`CREATE TYPE e AS ENUM ('a'); CREATE FUNCTION e_text(e) RETURNS text LANGUAGE plpgsql AS $$ BEGIN RETURN 'a'; END $$; CREATE CAST (e AS text) WITH FUNCTION e_text(e);`,
		],
		["a domain whose check calls one", `${OK} CREATE DOMAIN d AS int CHECK (ok(VALUE));`],
	])(
		"holds code no statement names for %s",
		async (_, made) => {
			expect(await held(made, flags)).toMatchObject({ events: false, opaque: true })
		},
		60_000,
	)

	it("holds an event trigger, its function kept in pg_catalog so it stands alone", async () => {
		const made =
			"CREATE FUNCTION pg_catalog.comb_t_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$; CREATE EVENT TRIGGER comb_t_ddl ON ddl_command_end EXECUTE FUNCTION pg_catalog.comb_t_ddl();"
		expect(await held(made, flags)).toEqual({ events: true, opaque: false, tables: [] })
	}, 60_000)

	it("hands on each LANGUAGE sql function's definition and every function's name, its body proven beside the directory's", async () => {
		const made = `CREATE FUNCTION one() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$; CREATE FUNCTION two() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 2; END; ${OP}`
		expect(await held(made, (code) => [code.trees.length, code.names])).toEqual([2, ["one", "op", "two"]])
	}, 60_000)

	it("reads the target with the postgres package comb loads itself", async () => {
		const code = await withScratchDb((url) => targetCode({ devUrl: url, lockTimeout: "5s", schema: "public", url }))
		expect(code.events).toBe(false)
	}, 60_000)
})
