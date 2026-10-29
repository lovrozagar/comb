/**
 * Default-deny (plan 12, 1.1): a statement rates safe or cautious only as a shape comb recognizes;
 * every other is unsafe and names itself. The 0.10 review's bypasses (M1–M6, M16) and the shapes
 * Atlas and comb write that must keep their ratings.
 */
import { describe, expect, it } from "vitest"
import type { ExtractedSchema } from "../types.ts"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const before = (sql: string, dialect: "postgres" | "sqlite" = "sqlite"): ExtractedSchema =>
	extractSchema(sql, undefined, dialect)
const rate = (sql: string, history: string, dialect: "postgres" | "sqlite" = "sqlite") =>
	classifyMigration(sql, { before: before(history, dialect), dialect })

const USERS = "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);"
/** Atlas's rebuild of t with `copy` as the copy's select list */
const castRebuild = (copy: string) => `PRAGMA foreign_keys = off;
CREATE TABLE \`new_t\` (\`id\` integer NULL PRIMARY KEY, \`n\` integer NULL, \`b\` blob NULL);
INSERT INTO \`new_t\` (\`id\`, \`n\`, \`b\`) SELECT \`id\`, ${copy} FROM \`t\`;
DROP TABLE \`t\`;
ALTER TABLE \`new_t\` RENAME TO \`t\`;
PRAGMA foreign_keys = on;
`
const T = "CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, b BLOB);"

describe("policies: recognized, and cautious, as they destroy no value (M16)", () => {
	it("calls a policy that hides every row cautious, naming whose rows on which table, so --yes is needed", () => {
		const rated = rate("ALTER POLICY p ON users USING (false);", "CREATE TABLE users (id int);", "postgres")
		expect(rated.safety).toBe("cautious")
		expect(rated.cautiousStatements).toEqual([
			"ALTER POLICY p ON users USING (false) (changes which rows its roles see on users)",
		])
	})

	it.each([
		['CREATE POLICY "readable" ON "post" AS PERMISSIVE FOR SELECT TO public USING (true)', "public sees on post"],
		['CREATE POLICY p ON app.post FOR ALL TO reader, "Writer" USING (true)', "reader, Writer see on app.post"],
		["CREATE POLICY p ON post USING (owner = current_user)", "public sees on post"],
		["ALTER POLICY p ON post TO admin USING (true)", "admin sees on post"],
		["DROP POLICY IF EXISTS p ON post", "its roles see on post"],
		["ALTER TABLE post ENABLE ROW LEVEL SECURITY", "each role sees on post"],
		["ALTER TABLE post FORCE ROW LEVEL SECURITY", "each role sees on post"],
		["ALTER TABLE post DISABLE ROW LEVEL SECURITY", "each role sees on post"],
	])("calls %j cautious: changes which rows %s", (sql, who) => {
		const rated = rate(sql, "CREATE TABLE post (id int, owner text);", "postgres")
		expect(rated.safety).toBe("cautious")
		expect(rated.cautiousStatements.join("\n")).toContain(`changes which rows ${who}`)
	})
})

describe("default-deny: the 0.10 review's bypasses are unsafe (M1–M6)", () => {
	it.each([
		["M1: a CAST to real in a rebuild's copy", castRebuild("CAST(`n` AS real) AS `n`, `b` AS `b`"), T],
		["M1: a CAST to integer in a rebuild's copy", castRebuild("CAST(`n` AS integer) AS `n`, `b` AS `b`"), T],
		[
			"M2: a trigger that RAISE(IGNORE)s every insert",
			"CREATE TRIGGER no_signups BEFORE INSERT ON users BEGIN SELECT RAISE(IGNORE); END;",
			USERS,
		],
		[
			"M3: a TEMP table named like a live table",
			"CREATE TEMP TABLE users AS SELECT * FROM main.users WHERE coalesce(email, '') NOT LIKE '%@%';\nDROP TABLE users;",
			USERS,
		],
	])("%s", (_, sql, history) => {
		const rated = rate(sql, history)
		expect(rated.safety).toBe("unsafe")
	})

	it.each([
		[
			"M5: a function the file creates, as a column's DEFAULT",
			"CREATE FUNCTION wipe() RETURNS int LANGUAGE sql AS $$ DELETE FROM sessions RETURNING 1 $$;\nALTER TABLE users ADD COLUMN x int DEFAULT wipe();",
		],
		["M5: a call in an added CHECK", "ALTER TABLE users ADD CONSTRAINT c CHECK (wipe() = 1);"],
		["M5: a call in SET DEFAULT", "ALTER TABLE users ALTER COLUMN email SET DEFAULT wipe();"],
		[
			"M6: replacing a trigger's function",
			"CREATE OR REPLACE FUNCTION audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM sessions; RETURN NEW; END $$;",
		],
		["a DO block", "DO $$ BEGIN PERFORM 1; END $$;"],
	])("%s (postgres)", (_, sql) => {
		/* wipe() is an earlier migration's, as a function a file calls usually is */
		const history =
			"CREATE TABLE users (id int PRIMARY KEY, email text); CREATE TABLE sessions (uid int); CREATE FUNCTION wipe() RETURNS int LANGUAGE sql AS $$ DELETE FROM sessions RETURNING 1 $$;"
		expect(rate(sql, history, "postgres").safety).toBe("unsafe")
	})

	it("names what it does not recognize, and how to approve it, as written but its TEMP", () => {
		expect(rate("CREATE TEMP FOO x;", USERS).unsafeStatements).toEqual([
			"CREATE TEMP FOO x (comb does not recognize CREATE FOO; approve it in the file)",
		])
		expect(
			rate("CREATE OR REPLACE AGGREGATE a (int) (SFUNC = f, STYPE = int);", USERS, "postgres").unsafeStatements.join(),
		).toContain("comb does not recognize CREATE OR REPLACE AGGREGATE; approve it in the file")
	})
})

/* S10 and P16 of the 0.15.0 review: a statement comb rates is never also one it "does not recognize" */
describe("default-deny's rule for triggers and routines, named as the rule", () => {
	it.each([
		["CREATE TRIGGER t AFTER INSERT ON users BEGIN DELETE FROM users; END;", "comb rates every trigger change unsafe"],
		["CREATE TEMP TRIGGER t AFTER INSERT ON users BEGIN SELECT 1; END;", "comb rates every trigger change unsafe"],
		["DROP TRIGGER t;", "comb rates every trigger change unsafe"],
		/* the rerun of S10 on the RC: a pragma comb does not write, rated by its own rule too */
		["PRAGMA writable_schema = ON;", "comb rates every pragma it does not write unsafe"],
		["PRAGMA journal_mode = WAL;", "comb rates every pragma it does not write unsafe"],
	])("rates %j unsafe by the rule, on SQLite", (sql, rule) => {
		const notes = rate(sql, USERS).unsafeStatements.join("\n")
		expect(notes).toContain(`${rule}; approve it in the file`)
		expect(notes).not.toContain("does not recognize")
	})

	/* R4: the rule is a pragma's only note, never beside a cautious one that says it merely changes how SQLite runs */
	it.each(["PRAGMA recursive_triggers = on;", "PRAGMA journal_mode = WAL;"])("gives %j no cautious note", (sql) => {
		const rated = rate(sql, USERS)
		expect(rated.cautiousStatements).toEqual([])
		expect(rated.unsafeStatements.join("\n")).toContain("comb rates every pragma it does not write unsafe")
	})

	it.each([
		[
			"CREATE TRIGGER t2 BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();",
			"comb rates every trigger change unsafe",
		],
		["DROP FUNCTION dbl(int);", "comb rates every function change unsafe"],
		["CREATE OR REPLACE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$;", "comb rates every procedure change unsafe"],
		["CREATE RULE r AS ON INSERT TO users DO INSTEAD NOTHING;", "comb rates every rule change unsafe"],
		["DO $$ BEGIN PERFORM 1; END $$;", "comb rates every DO block unsafe"],
	])("rates %j unsafe by the rule, on Postgres", (sql, rule) => {
		const rated = rate(sql, "CREATE TABLE users (id int);", "postgres")
		expect(rated.safety).toBe("unsafe")
		const notes = rated.unsafeStatements.join("\n")
		expect(notes).toContain(`${rule}; approve it in the file`)
		expect(notes).not.toContain("does not recognize")
	})
})

/* on SQLite the proof's engine pass names these (plan-apply.engine.test.ts) */
describe("default-deny on Postgres: a temp shadow and a live trigger (M3, M4)", () => {
	it.each([
		[
			"M3: a TEMP table named like a live table",
			"CREATE TEMP TABLE users AS SELECT * FROM users WHERE false;",
			"shadows users",
		],
		[
			"M4: a write a live trigger observes",
			"INSERT INTO users (email) VALUES ('x');",
			"fires trigger wipe, whose body runs for every row it writes",
		],
	])("%s (postgres)", (_, sql, note) => {
		const history =
			"CREATE TABLE users (id int PRIMARY KEY, email text); CREATE TABLE sessions (uid int); CREATE TRIGGER wipe AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION wipe();"
		expect(rate(sql, history, "postgres").unsafeStatements.join("\n")).toContain(note)
	})
})

/** comb's DROP and remake of a sync trigger named `name` with `body` */
const sync = (name: string, body: string) =>
	`DROP TRIGGER IF EXISTS "${name}";\nCREATE TRIGGER IF NOT EXISTS ${name} AFTER DELETE ON post BEGIN\n\t${body};\nEND;`

/* comb's own FTS migration drops and remakes an external-content table's sync triggers (fts-migration.ts) */
describe("default-deny on FTS sync triggers", () => {
	const FTS =
		"CREATE TABLE post (id INTEGER PRIMARY KEY, title TEXT);\nCREATE VIRTUAL TABLE post_fts USING fts5(title, content='post', content_rowid='id');"
	it("recognizes the sync trigger comb writes, and its drop", () => {
		const rated = rate(
			sync("post_fts_ad", "INSERT INTO post_fts(post_fts, rowid, title) VALUES ('delete', old.id, old.title)"),
			FTS,
		)
		expect(rated.unsafeStatements).toEqual([])
	})

	it("rates a trigger that writes anywhere else, or anything else, unsafe", () => {
		for (const body of [
			"INSERT INTO post(id) VALUES (old.id)",
			"INSERT INTO post_fts(post_fts) VALUES ('delete-all')",
			"DELETE FROM post",
		])
			expect(rate(sync("t", body), FTS).safety).toBe("unsafe")
	})

	it("recognizes a sync trigger on an FTS table the file makes", () => {
		const made = `CREATE VIRTUAL TABLE note_fts USING fts5(title, content='post', content_rowid='id');\n${sync("note_fts_ad", "INSERT INTO note_fts(note_fts, rowid, title) VALUES ('delete', old.id, old.title)").replaceAll("post_fts", "note_fts")}`
		expect(rate(made, USERS.replace("users", "post")).unsafeStatements).toEqual([])
	})
})

describe("default-deny keeps the shapes it recognizes (controls)", () => {
	it.each([
		["a new table", "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);", "safe"],
		["a new index", "CREATE INDEX idx_users_email ON users (email);", "safe"],
		["a new view", "CREATE VIEW emails AS SELECT email FROM users;", "safe"],
		["a nullable column", "ALTER TABLE users ADD COLUMN bio TEXT;", "safe"],
		["a column with a constant default", "ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';", "safe"],
		[
			"an insert into a table the file created",
			"CREATE TABLE tiers (id TEXT);\nINSERT INTO tiers VALUES ('free');",
			"safe",
		],
		["Atlas's plain rebuild", castRebuild("`n` AS `n`, `b` AS `b`"), "cautious"],
	])("%s", (_, sql, safety) => {
		const history = sql.includes("`new_t`") ? T : USERS
		expect(rate(sql, history).safety).toBe(safety)
	})
})
