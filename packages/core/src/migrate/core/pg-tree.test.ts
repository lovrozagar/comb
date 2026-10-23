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
