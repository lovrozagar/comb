import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const pg = (sql: string) => classifyMigration(sql, { dialect: "postgres" })

/* the write bypasses of the 0.7.0 review (classify-probe.ts): a write hidden in a CTE or a subquery, or filtered by a tautology */
describe("classifyMigration on a write that hid", () => {
	it.each([
		["WITH d AS (DELETE FROM users RETURNING *) INSERT INTO archive SELECT * FROM d;", "a CTE DELETE"],
		["WITH u AS (UPDATE users SET email = NULL RETURNING id) SELECT count(*) FROM u;", "a CTE UPDATE"],
		["WITH a AS (WITH b AS (DELETE FROM users RETURNING *) SELECT * FROM b) SELECT * FROM a;", "a nested CTE"],
		[
			"INSERT INTO archive SELECT * FROM (WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d) s;",
			"a subquery CTE",
		],
		[
			"WITH m AS (MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE RETURNING *) SELECT * FROM m;",
			"a CTE MERGE",
		],
		['DELETE FROM "where";', "a table named where"],
		["DELETE FROM users WHERE true;", "WHERE true"],
		["DELETE FROM users WHERE 1=1;", "WHERE 1=1"],
		["UPDATE users SET a = 1 WHERE id = id;", "WHERE id = id"],
		["DELETE FROM users WHERE (true);", "WHERE (true)"],
		["DELETE FROM users WHERE id = 5 OR 1 = 1;", "a tautology disjunct"],
		["UPDATE users SET a = 1 WHERE NOT false;", "WHERE NOT false"],
	])("calls %j unsafe (%s)", (sql) => {
		expect(pg(sql).safety).toBe("unsafe")
	})

	it.each([
		"WITH d AS (SELECT 1) INSERT INTO t SELECT * FROM d",
		"INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
	])("keeps %j safe", (sql) => {
		expect(pg(sql).safety).toBe("safe")
	})

	it("calls a write filtered through a subquery, or returning its rows, unsafe", () => {
		expect(pg("UPDATE post SET a = 1 WHERE id IN (SELECT id FROM gone)").safety).toBe("unsafe")
		expect(pg("DELETE FROM users WHERE id = 1 RETURNING *").safety).toBe("unsafe")
	})
})

/* the bypasses of the G1 review (byp.ts, byp2.ts): a write that runs at apply time while rated lower */
describe("classifyMigration on a write the G1 review found rated low", () => {
	it.each([
		["PREPARE s AS DELETE FROM t; EXECUTE s;", "unsafe", "an EXECUTE of a statement the file prepares"],
		["PREPARE s (int) AS UPDATE t SET x = 1 WHERE id = $1; EXECUTE s(1);", "unsafe", "a filtered prepared write"],
		["EXECUTE stmt;", "unsafe", "an EXECUTE, no shape comb recognizes"],
		["PREPARE s AS SELECT 1;", "unsafe", "a PREPARE, no shape comb recognizes"],
		["SELECT setval('s', 1);", "cautious", "setval"],
		["SELECT pg_catalog.setval('s', 1, false);", "cautious", "a qualified setval"],
		["CREATE RULE r AS ON INSERT TO t DO INSTEAD DELETE FROM t;", "unsafe", "an unfiltered rule action"],
		[
			"CREATE OR REPLACE RULE r AS ON UPDATE TO t DO ALSO UPDATE t SET x = 1 WHERE id = old.id;",
			"unsafe",
			"a filtered rule action",
		],
		["CREATE RULE r AS ON INSERT TO t DO INSTEAD NOTHING;", "unsafe", "a rule that discards every insert (M9)"],
		["ALTER TABLE t OWNER TO nobody;", "cautious", "a new owner, who bypasses row level security"],
		["REASSIGN OWNED BY a TO b;", "unsafe", "reassigned ownership, no shape comb recognizes"],
		["COPY t FROM PROGRAM 'x';", "unsafe", "a COPY, no shape comb recognizes"],
		["COPY t TO STDOUT;", "unsafe", "a COPY, no shape comb recognizes"],
		[
			"CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\nCREATE TRIGGER t AFTER INSERT ON post FOR EACH ROW EXECUTE FUNCTION f();",
			"unsafe",
			"a function and a trigger, however harmless their bodies",
		],
		[
			"CREATE FUNCTION f() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;\nCREATE POLICY p ON post USING (f());",
			"unsafe",
			"a function and a policy",
		],
	])("rates %j %s (%s)", (sql, safety) => {
		expect(pg(sql).safety).toBe(safety)
	})
})

/* the G3 review (loss-proof.ts, classify-probe.ts): no WHERE makes a DELETE or an UPDATE of existing values
   safe to run. On SQLite the proof's engine pass rates writes (plan-apply.engine.test.ts); these are Postgres's */

describe("classifyMigration: a DELETE, and an UPDATE of existing values, may destroy them", () => {
	it.each([
		"DELETE FROM users WHERE email IS NULL OR email IS NOT NULL;",
		"DELETE FROM users WHERE 1 < 2;",
		"DELETE FROM users WHERE NULL IS NULL;",
		"DELETE FROM users WHERE 1 = 1.0;",
		"DELETE FROM users WHERE id = 1;",
		"UPDATE users SET tier = 'pro' WHERE id = 1;",
		"INSERT INTO users (id, tier) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET tier = excluded.tier;",
	])("calls %j unsafe", (sql) => {
		expect(pg(sql).safety).toBe("unsafe")
	})

	it("calls a MERGE that updates or deletes unsafe, and one that only inserts cautious", () => {
		expect(pg("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET x = s.x").safety).toBe("unsafe")
		expect(pg("MERGE INTO t USING s ON t.id = s.id WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)").safety).toBe(
			"cautious",
		)
	})

	it("calls a backfill of columns this file added cautious, and a write to an older one unsafe", () => {
		const added =
			'ALTER TABLE users ADD COLUMN tier text;\nALTER TABLE "users" ADD COLUMN "since" integer, ADD COLUMN x text;\n'
		expect(pg(`${added}UPDATE users SET (tier, x) = ('free', 'y');`).safety).toBe("cautious")
		expect(pg(`${added}UPDATE users SET tier = 'free', email = NULL;`).safety).toBe("unsafe")
		/* the parse tree names the column an element belongs to: the file's own, which held nothing before it */
		expect(pg("ALTER TABLE users ADD COLUMN tags text[];\nUPDATE users SET tags[1] = 'x';").safety).toBe("cautious")
		expect(pg("UPDATE users SET email[1] = 'x';").safety).toBe("unsafe")
		expect(pg(`UPDATE users SET tier = 'free';\n${added}`).safety).toBe("unsafe")
	})
})

/* the fresh-table and fresh-column bypasses of the 0.9.1 review (M3, M4): a name that only looks new */
describe("classifyMigration on a backfill of something that held data", () => {
	const users = "CREATE TABLE users (id integer PRIMARY KEY, email text);"
	const before = (dialect: "postgres" | "sqlite") => extractSchema(users, undefined, dialect)
	const rate = (sql: string, dialect: "postgres" | "sqlite") =>
		classifyMigration(sql, { before: before(dialect), dialect }).safety

	it("rates an UPDATE after CREATE TABLE IF NOT EXISTS of an existing table unsafe", () => {
		expect(
			rate(
				"CREATE TABLE IF NOT EXISTS users (id integer PRIMARY KEY, email text);\nUPDATE users SET email = NULL;",
				"postgres",
			),
		).toBe("unsafe")
		expect(
			rate("CREATE TABLE Users (id integer PRIMARY KEY, email text);\nUPDATE users SET email = NULL;", "postgres"),
		).toBe("unsafe")
	})

	it("rates an UPDATE of a column added IF NOT EXISTS, or one the table had, unsafe", () => {
		expect(
			rate("ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;\nUPDATE users SET email = NULL;", "postgres"),
		).toBe("unsafe")
		expect(rate("ALTER TABLE users ADD COLUMN email text;\nUPDATE users SET email = NULL;", "postgres")).toBe("unsafe")
		expect(rate("ALTER TABLE users ADD COLUMN tier text;\nUPDATE users SET tier = 'free';", "postgres")).toBe(
			"cautious",
		)
	})

	it("matches a schema-qualified table whole: another schema's table makes no unqualified one fresh", () => {
		expect(rate("CREATE TABLE other_schema.users (id int);\nUPDATE users SET email = NULL;", "postgres")).toBe("unsafe")
		expect(pg("CREATE TABLE other_schema.audit (id int, n int);\nUPDATE audit SET n = 0;").safety).toBe("unsafe")
		expect(pg("CREATE TABLE other_schema.audit (id int, n int);\nUPDATE Other_Schema.audit SET n = 0;").safety).toBe(
			"cautious",
		)
	})

	it("rates a write to a rebuild's copy before the rename unsafe, whatever the copy kept", () => {
		const rebuild =
			"CREATE TABLE new_users (id integer PRIMARY KEY, email text);\nINSERT INTO new_users (id, email) SELECT id, email FROM users;\nUPDATE new_users SET email = NULL;\nDROP TABLE users;\nALTER TABLE new_users RENAME TO users;"
		const read = classifyMigration(rebuild, { before: before("sqlite"), dialect: "sqlite" })
		expect(read.safety).toBe("unsafe")
		expect(read.unsafeStatements.join("\n")).toContain("its copy is changed before the rename")
	})
})

/* M74 of the 0.13.0 review: a renamed schema's tables keep the triggers the history put on them */
describe("classifyMigration on a write to a table whose schema the history renamed", () => {
	it("rates an insert unsafe for the trigger it fires under the new name", () => {
		const before = extractSchema(
			"CREATE SCHEMA app;\nCREATE TABLE app.users (id int);\nCREATE FUNCTION public.wipe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM victim; RETURN NEW; END $$;\nCREATE TRIGGER t AFTER INSERT ON app.users FOR EACH ROW EXECUTE FUNCTION public.wipe();\nALTER SCHEMA app RENAME TO app2;",
			undefined,
			"postgres",
		)
		const rated = classifyMigration("INSERT INTO app2.users VALUES (1);", { before, dialect: "postgres" })
		expect(rated.safety).toBe("unsafe")
	})
})
