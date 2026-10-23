import { beforeAll, describe, expect, it, vi } from "vitest"
import { classifyMigration } from "./classify.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

/* the history: a users table, and an audit table a trigger on users writes */
const BEFORE = extractSchema(
	"CREATE TABLE users (id int PRIMARY KEY, email text);\nCREATE TABLE audit (note text);\nCREATE TABLE logged (id int);\nCREATE TRIGGER logged_audit AFTER INSERT OR UPDATE ON logged FOR EACH ROW EXECUTE FUNCTION audit_fn();",
	undefined,
	"postgres",
)

const rate = (sql: string) => classifyMigration(sql, { before: BEFORE, dialect: "postgres" })
const notes = (sql: string) => {
	const rated = rate(sql)
	return [...rated.unsafeStatements, ...rated.cautiousStatements].join("\n")
}

describe("Postgres classification before the parser is loaded", () => {
	it("refuses, and says what to load", async () => {
		/* a fresh module graph: the setup file loaded the parser in the one the other tests share */
		vi.resetModules()
		const fresh = await import("./classify.ts")
		expect(() => fresh.classifyMigration("SELECT 1;", { dialect: "postgres" })).toThrow(/loadPostgresParser/)
	})
})

/*
 * Plan 13, M4 of the 0.12 round: Postgres statements are read from Postgres's own parser
 * (libpg-query 17), so no spelling hides a write: an inheritance star, a Unicode-escaped name, no
 * space before SET, or an upsert in a CTE.
 */
describe("Postgres classification from the parse tree", () => {
	beforeAll(loadPostgresParser)

	it.each([
		["M4, an inheritance star", "UPDATE users* SET email = NULL WHERE id > 0;"],
		["M4, a Unicode-escaped name", `UPDATE U&"users" SET email = NULL WHERE id > 0;`],
		["M4, no space before SET", `UPDATE "users"SET email = NULL WHERE id > 0;`],
		[
			"M4, an upsert in a CTE",
			"WITH w AS (INSERT INTO users (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET email = excluded.email RETURNING 1) SELECT count(*) FROM w;",
		],
		["a DELETE, whatever its WHERE", "DELETE FROM users WHERE id = 1;"],
		["a MERGE that deletes", "MERGE INTO users u USING audit a ON false WHEN MATCHED THEN DELETE;"],
		["dblink, which runs SQL comb cannot read", "SELECT dblink_exec('conn', 'DELETE FROM users');"],
		["a DO block", "DO $$ BEGIN PERFORM 1; END $$;"],
		["a function", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;"],
		["a function in public", "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nSELECT f();"],
		["a procedure", "CREATE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$;"],
		["a trigger", "CREATE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();"],
		["a CALL", "CALL p();"],
		["a call of a function comb cannot read", "SELECT my_func();"],
		["a call of one in a default", "ALTER TABLE users ADD COLUMN x int DEFAULT my_func();"],
		["a temp table that takes a table's name", "CREATE TEMP TABLE users (id int);"],
		["a pg_temp table that takes a table's name", "CREATE TABLE pg_temp.users (id int);"],
		["a temp view that takes a table's name", "CREATE TEMP VIEW users AS SELECT 1 AS id;"],
		["a temp table made from a query that takes a table's name", "CREATE TEMP TABLE users AS SELECT 1 AS id;"],
		["a write a live trigger observes", "INSERT INTO logged (id) VALUES (1);"],
		["a statement Postgres cannot parse", "UPDATE users SET;"],
	])("rates %s unsafe", (_label, sql) => {
		expect(rate(sql).safety).toBe("unsafe")
	})
})

describe("Postgres classification from the parse tree: notes and controls", () => {
	beforeAll(loadPostgresParser)

	it("reads a file with no history: a write fires nothing, and shadows nothing", () => {
		expect(
			classifyMigration("INSERT INTO logged (id) VALUES (1);\nCREATE TEMP TABLE users (id int);", {
				dialect: "postgres",
			}).safety,
		).toBe("safe")
	})

	it("names what it found", () => {
		expect(notes("UPDATE users* SET email = NULL;")).toContain("updates existing rows of users (email)")
		expect(notes("SELECT my_func();")).toContain("calls my_func, which comb cannot read")
		expect(notes("INSERT INTO logged (id) VALUES (1);")).toContain("fires trigger logged_audit")
		expect(notes("CREATE TEMP TABLE users (id int);")).toContain("shadows users for the rest of the file")
		expect(notes("UPDATE users SET;")).toMatch(/comb could not parse this as Postgres 17: syntax error/)
	})

	it.each([
		[
			"a new table, index and view",
			"CREATE TABLE t_new (id uuid DEFAULT gen_random_uuid(), at timestamptz DEFAULT now());\nCREATE VIEW v_new AS SELECT lower(email) FROM users;",
			"safe",
		],
		["a nullable ADD COLUMN", "ALTER TABLE users ADD COLUMN tier text;", "safe"],
		["an insert-only write", "INSERT INTO users (id, email) VALUES (1, lower('X'));", "safe"],
		["an insert that does nothing on a conflict", "INSERT INTO users (id) VALUES (1) ON CONFLICT DO NOTHING;", "safe"],
		[
			"a backfill of the file's own column, through a pure built-in",
			"ALTER TABLE users ADD COLUMN tier text;\nUPDATE users SET tier = coalesce(lower(email), 'free');",
			"cautious",
		],
		[
			"a write to a table the file created",
			"CREATE TABLE fresh (id int, a text);\nUPDATE fresh SET a = 'x';",
			"cautious",
		],
		["a sequence set by setval", "SELECT setval('users_id_seq', 10);", "cautious"],
		[
			"an insert-only MERGE",
			"MERGE INTO users u USING audit a ON false WHEN NOT MATCHED THEN INSERT (id) VALUES (1);",
			"cautious",
		],
		["a temp table of a new name", "CREATE TEMP TABLE scratch (id int);", "safe"],
	])("keeps %s at its rating", (_label, sql, safety) => {
		expect(rate(sql).safety).toBe(safety)
	})
})

/* T8 of the 2.3 review: one name key, public and unqualified alike, any other schema kept */
describe("Postgres names, keyed as Postgres resolves them", () => {
	beforeAll(loadPostgresParser)

	it("reads public.fresh and fresh as one table", () => {
		expect(rate("CREATE TABLE public.fresh (id int);\nUPDATE fresh SET id = 1;").safety).toBe("cautious")
		expect(rate("CREATE TABLE fresh (id int);\nUPDATE public.fresh SET id = 1;").safety).toBe("cautious")
	})

	it("keeps a table of another schema apart from public's", () => {
		expect(rate("CREATE SCHEMA s;\nCREATE TABLE s.users (id int, n int);\nUPDATE s.users SET n = 1;").safety).toBe(
			"cautious",
		)
		/* the history's trigger is on public.logged, not on s.logged */
		expect(
			rate("CREATE SCHEMA s;\nCREATE TABLE s.logged (id int);\nINSERT INTO s.logged (id) VALUES (1);").safety,
		).toBe("safe")
		expect(rate("INSERT INTO public.logged (id) VALUES (1);").safety).toBe("unsafe")
	})
})

/* T1, T2, T3 and T7 of the 2.3 review */
describe("Postgres statements that change what later names resolve to, or what a write runs", () => {
	beforeAll(loadPostgresParser)
	const OVERLOADED = extractSchema(
		"CREATE TYPE mytype AS (v int);\nCREATE TABLE users (id int PRIMARY KEY);\nCREATE FUNCTION public.lower(mytype) RETURNS text LANGUAGE sql AS $$ DELETE FROM users RETURNING 'x' $$;",
		undefined,
		"postgres",
	)

	it("reads a built-in's name that a migration defined as that migration's function (T1)", () => {
		const call = "SELECT 1 WHERE lower(ROW(1)::mytype) IS NULL;"
		expect(classifyMigration(call, { before: OVERLOADED, dialect: "postgres" }).safety).toBe("unsafe")
		expect(classifyMigration(call, { before: OVERLOADED, dialect: "postgres" }).unsafeStatements.join("\n")).toContain(
			"calls lower, a function a migration defined",
		)
		/* pg_catalog's own, called by its schema, is the built-in */
		expect(classifyMigration("SELECT pg_catalog.lower('X');", { before: OVERLOADED, dialect: "postgres" }).safety).toBe(
			"safe",
		)
	})

	it.each([
		["SET search_path TO public, pg_catalog;", "search_path"],
		["SET LOCAL search_path = app;", "search_path"],
		["RESET search_path;", "search_path"],
		["RESET ALL;", "every setting"],
		["SET session_replication_role = replica;", "session_replication_role"],
	])("rates %j unsafe (T2, T3)", (sql, setting) => {
		const rated = rate(sql)
		expect(rated.safety).toBe("unsafe")
		expect(rated.unsafeStatements.join("\n")).toMatch(new RegExp(`(?:sets|resets) ${setting}`))
	})

	it("keeps an ordinary setting safe", () => {
		expect(rate("SET statement_timeout = '5s';").safety).toBe("safe")
	})

	it("reads SELECT INTO TEMP as a temp table that takes the name (T7)", () => {
		expect(notes("SELECT * INTO TEMP users FROM audit;")).toContain("shadows users for the rest of the file")
		expect(rate("SELECT * INTO TEMP scratch FROM audit;").safety).toBe("safe")
	})
})

/* the history T4–T6 read against: partitions, inheritance, and code attached to tables */
const HISTORY = extractSchema(
	[
		"CREATE TABLE users (id int PRIMARY KEY, n int);",
		"CREATE FUNCTION wipe() RETURNS int LANGUAGE sql AS $$ DELETE FROM users RETURNING 1 $$;",
		"CREATE TABLE pp (id int, v int) PARTITION BY RANGE (id);",
		"CREATE TABLE pc PARTITION OF pp FOR VALUES FROM (0) TO (10);",
		"CREATE TRIGGER tp AFTER INSERT ON pc FOR EACH ROW EXECUTE FUNCTION wipe();",
		"CREATE TRIGGER tq AFTER UPDATE ON pp FOR EACH ROW EXECUTE FUNCTION wipe();",
		"CREATE TABLE ip (id int);",
		"CREATE TABLE ic (x int) INHERITS (ip);",
		"CREATE TRIGGER ti AFTER DELETE ON ic FOR EACH ROW EXECUTE FUNCTION wipe();",
		"CREATE TABLE d (id int, v int DEFAULT wipe());",
		"CREATE TABLE chk (id int, v int CHECK (v > wipe()));",
		"CREATE DOMAIN dd AS int CHECK (VALUE > wipe());",
		"CREATE TABLE dt (id int, v dd);",
		"CREATE TABLE rr (id int);",
		"CREATE RULE r AS ON INSERT TO rr DO ALSO DELETE FROM users;",
		"CREATE FUNCTION eq3(int, int) RETURNS bool LANGUAGE sql AS $$ SELECT true $$;",
		"CREATE OPERATOR === (FUNCTION = eq3, LEFTARG = int, RIGHTARG = int);",
		"CREATE TYPE mt AS (v int);",
		"CREATE FUNCTION tomt(int) RETURNS mt LANGUAGE sql AS $$ SELECT ROW($1)::mt $$;",
		"CREATE CAST (int AS mt) WITH FUNCTION tomt(int) AS IMPLICIT;",
		"CREATE TABLE ct (id int, m mt);",
	].join("\n"),
	undefined,
	"postgres",
)

const on = (sql: string) => classifyMigration(sql, { before: HISTORY, dialect: "postgres" })
const noted = (sql: string) => {
	const rated = on(sql)
	return { notes: [...rated.unsafeStatements, ...rated.cautiousStatements].join("\n"), safety: rated.safety }
}

/* T4, T5 and T6 of the 2.3 review: what a write reaches through parentage, and the code the history attached to a table */
describe("Postgres writes through partitions, inheritance and the history's attached code", () => {
	beforeAll(loadPostgresParser)

	it("takes a parent out of the fresh tables once an existing table becomes its child (T4)", () => {
		expect(
			noted(
				"CREATE TABLE q (id int, n int) PARTITION BY RANGE (id);\nALTER TABLE q ATTACH PARTITION users FOR VALUES FROM (0) TO (100);\nUPDATE q SET n = 0;",
			).notes,
		).toContain("updates existing rows of q (n)")
		expect(noted("CREATE TABLE p (id int, n int);\nALTER TABLE users INHERIT p;\nUPDATE p SET n = 0;").notes).toContain(
			"updates existing rows of p (n)",
		)
	})

	it.each([
		["an insert routed to a partition that has a trigger", "INSERT INTO pp (id, v) VALUES (1, 1);", "fires trigger tp"],
		["an update of a partition whose parent has a trigger", "UPDATE pc SET v = 1;", "fires trigger tq"],
		["a delete of an inheritance parent whose child has a trigger", "DELETE FROM ip;", "fires trigger ti"],
	])("names %s (T5)", (_label, sql, note) => {
		expect(noted(sql).notes).toContain(note)
	})

	it("leaves a parent's children out of a write to ONLY the parent", () => {
		expect(noted("DELETE FROM ONLY ip;").notes).not.toContain("fires trigger ti")
	})
})

describe("Postgres writes that run the code the history attached (T6)", () => {
	beforeAll(loadPostgresParser)

	it.each([
		["a DEFAULT that calls a function", "INSERT INTO d (id) VALUES (1);", "runs wipe on every write to d"],
		["a CHECK that calls a function", "INSERT INTO chk (id, v) VALUES (1, 1);", "runs wipe on every write to chk"],
		[
			"a domain whose CHECK calls a function",
			"INSERT INTO dt (id, v) VALUES (1, 1);",
			"runs wipe on every write to dt",
		],
		["a rule", "INSERT INTO rr (id) VALUES (1);", "runs rule r on every write to rr"],
		[
			"a copy made LIKE such a table",
			"CREATE TABLE c2 (LIKE chk INCLUDING ALL);\nINSERT INTO c2 (id, v) VALUES (1, 1);",
			"runs wipe on every write to c2",
		],
		[
			"a column of a type an implicit cast reaches",
			"INSERT INTO ct (id, m) VALUES (1, 1);",
			"runs tomt on every write to ct",
		],
		["a migration's operator", "SELECT 1 === 2;", "uses operator ===, which a migration defined"],
		[
			"a cast to a type a migration's cast reaches",
			"SELECT 1::mt;",
			"casts to mt through tomt, which a migration defined",
		],
	])("rates %s unsafe (T6)", (_label, sql, note) => {
		const rated = on(sql)
		expect(rated.safety).toBe("unsafe")
		expect(rated.unsafeStatements.join("\n")).toContain(note)
	})
})
