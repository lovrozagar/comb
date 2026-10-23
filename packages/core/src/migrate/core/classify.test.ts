import { describe, expect, it, vi } from "vitest"
import type { ExtractedSchema } from "../types.ts"
import { classifyMigration, extractDropStatements } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const pg = (sql: string) => classifyMigration(sql, { dialect: "postgres" })
const lite = (sql: string, before?: ExtractedSchema) => classifyMigration(sql, { before, dialect: "sqlite" })
const schemaWith = (table: string, columns: string[]): ExtractedSchema => ({
	droppedTables: [],
	externalFts: [],
	foreignKeys: [],
	statements: [],
	indexes: [],
	tableInfo: new Map(),
	tables: new Map([[table, columns]]),
	triggers: [],
})

/* Atlas v1.3.0's own output for each change on Postgres 17 (plan6-security.md §1) */
describe("classifyMigration on Atlas's Postgres output", () => {
	it.each([
		['DROP TABLE "public"."gone";', "drop table"],
		['ALTER TABLE "public"."post" DROP COLUMN "body";', "drop column"],
		['ALTER TABLE "public"."post" DROP COLUMN "body", ADD COLUMN "content" text NULL;', "rename column"],
		['ALTER TABLE "public"."post" DROP COLUMN "body", ALTER COLUMN "big" TYPE integer;', "drop and retype"],
		['DROP SCHEMA "extra" CASCADE;', "drop schema"],
		['ALTER TABLE "public"."post" ALTER COLUMN "big" TYPE integer;', "bigint to integer"],
		['ALTER TABLE "public"."post" ALTER COLUMN "price" TYPE numeric(6,1);', "numeric narrowed"],
		['ALTER TABLE "public"."post" ALTER COLUMN "body" SET NOT NULL;', "set not null"],
		['ALTER TABLE "public"."post" ADD COLUMN "req" text NOT NULL;', "not null without default"],
		['CREATE TABLE "public"."gone2" ("id" integer NOT NULL);\nDROP TABLE "public"."gone";', "rename table"],
		['ALTER TABLE "public"."post" DROP COLUMN "m";\nDROP TYPE "public"."mood";', "drop enum type"],
	])("calls %j unsafe (%s)", (sql) => {
		expect(pg(sql).safety).toBe("unsafe")
	})

	it.each([
		['DROP INDEX "public"."idx_post_slug";', "drop index"],
		['ALTER TABLE "public"."post" DROP CONSTRAINT "post_n_check";', "drop check"],
		['ALTER TABLE "public"."post" ALTER COLUMN "n" DROP DEFAULT;', "drop default"],
	])("calls %j cautious (%s)", (sql) => {
		expect(pg(sql).safety).toBe("cautious")
	})

	it("calls DROP NOT NULL safe", () => {
		expect(pg('ALTER TABLE "public"."post" ALTER COLUMN "title" DROP NOT NULL;').safety).toBe("safe")
	})
})

describe("classifyMigration lists a statement at its strictest level alone", () => {
	it("leaves an unsafe statement out of the cautious list, whatever its notes say", () => {
		const before = extractSchema(
			"CREATE TABLE t (id int); CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;",
			undefined,
			"postgres",
		)
		const replaced =
			"CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM t; RETURN NEW; END $$;"
		const c = classifyMigration(replaced, { before, dialect: "postgres" })
		expect(c.unsafeStatements).toEqual([
			expect.stringContaining("comb does not recognize CREATE OR REPLACE FUNCTION"),
			expect.stringContaining("creates function f, whose body comb does not read"),
		])
		expect(c.cautiousStatements).toEqual([])
	})
})

describe("classifyMigration on hand-written Postgres that loses data", () => {
	it.each([
		"ALTER TABLE ONLY post DROP COLUMN c",
		"ALTER TABLE IF EXISTS ONLY post DROP COLUMN IF EXISTS c",
		"ALTER TABLE post ADD COLUMN x int, DROP COLUMN body",
		"ALTER TABLE post DROP body",
		"ALTER TABLE post ALTER COLUMN c SET DATA TYPE bigint",
		"ALTER TABLE post ALTER c TYPE bigint",
		"ALTER TABLE post RENAME COLUMN a TO b",
		"ALTER TABLE post RENAME TO posts",
		"ALTER TABLE post SET SCHEMA archive",
		"ALTER TYPE mood RENAME VALUE 'a' TO 'b'",
		"ALTER TYPE mood RENAME TO feeling",
		"TRUNCATE post",
		"DELETE FROM post",
		"DELETE FROM post USING (SELECT 1 WHERE true) s",
		"UPDATE post SET a = 1",
		"WITH x AS (SELECT 1 WHERE true) DELETE FROM post",
		"MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE",
		"DROP SEQUENCE s",
		"DROP ROLE r",
		"DROP EXTENSION e",
		"DROP MATERIALIZED VIEW m",
		"DROP OWNED BY r",
		"DROP DOMAIN d",
		"DROP VIEW v CASCADE",
		"DO $$ BEGIN DROP TABLE post; END $$",
		"DO $d$ BEGIN IF true THEN TRUNCATE post; END IF; END $d$",
		"SELECT E'\\''; DROP TABLE \"post\"; -- ';",
		"DO $$ BEGIN EXECUTE 'DROP TABLE post'; END $$",
	])("calls %j unsafe", (sql) => {
		expect(pg(sql).safety).toBe("unsafe")
	})
})

describe("classifyMigration on hand-written Postgres that keeps every row", () => {
	it.each([
		"DROP VIEW v",
		"MERGE INTO t USING s ON t.id = s.id WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)",
		"CREATE OR REPLACE VIEW v AS SELECT 1",
		"GRANT SELECT ON post TO r",
		"REVOKE SELECT ON post FROM r",
		"ALTER SEQUENCE s RESTART",
		"ALTER INDEX i RENAME TO j",
		"ALTER TABLE post DISABLE ROW LEVEL SECURITY",
		"ALTER TABLE post DISABLE TRIGGER USER",
		"ALTER TABLE post SET LOGGED",
		"ALTER TABLE post ALTER COLUMN id DROP IDENTITY",
		"-- atlas:txmode none\n\nCREATE INDEX CONCURRENTLY i ON post (a);",
	])("calls %j cautious", (sql) => {
		expect(pg(sql).safety).toBe("cautious")
	})

	it.each([
		"ALTER TYPE mood ADD VALUE 'c'",
		"ALTER TABLE post ADD COLUMN x text NOT NULL DEFAULT ''",
		"ALTER TABLE post ADD COLUMN n bigint NOT NULL GENERATED ALWAYS AS IDENTITY",
		"ALTER TABLE post ALTER COLUMN a SET DEFAULT 1",
		"CREATE TABLE child (id int REFERENCES parent (id) ON DELETE CASCADE)",
		"ALTER TABLE post ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES b (id) ON DELETE CASCADE NOT VALID",
		"SELECT 'DROP TABLE post'",
	])("calls %j safe", (sql) => {
		expect(pg(sql).safety).toBe("safe")
	})

	/* default-deny: code that runs on later writes, or that decides what the deployed code reads */
	it.each([
		"DROP TRIGGER t ON post",
		"DROP FUNCTION f()",
		"CREATE FUNCTION f() RETURNS void AS $$ DROP TABLE post $$ LANGUAGE sql",
		"CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql",
		"DO $$ BEGIN EXECUTE format('DROP TABLE %I', 'post'); END $$",
	])("calls %j unsafe: no shape comb recognizes", (sql) => {
		expect(pg(sql).unsafeStatements.join("\n")).toMatch(/comb does not recognize/)
	})
})

/* the drop-gate bypasses of the 0.7.0 review (classify-probe.ts), each with the rating it must get */
describe("classifyMigration on SQL that hid a destructive change", () => {
	it.each([
		["DO $$\nBEGIN\n  -- purge old rows\n  DELETE FROM users;\nEND\n$$;", "a line comment in a DO body"],
		["DO $$ BEGIN /* x */ DELETE FROM users; END $$;", "a block comment in a DO body"],
		["DO $$ BEGIN UPDATE users SET note = 'WHERE'; END $$;", "a DO body string holding WHERE"],
		["ALTER VIEW IF EXISTS active_users RENAME TO live_users;", "a view rename with IF EXISTS"],
		["ALTER MATERIALIZED VIEW IF EXISTS mv RENAME TO mv2;", "a materialized view rename with IF EXISTS"],
		['ALTER TYPE "order status" RENAME TO order_state;', "a rename of a quoted name with a space"],
		["EXPLAIN ANALYZE DELETE FROM users;", "EXPLAIN ANALYZE"],
		["EXPLAIN (ANALYZE, BUFFERS) UPDATE users SET a = 1;", "EXPLAIN with options"],
		["DO $$ BEGIN EXECUTE 'DELETE FROM users'; END $$;", "EXECUTE of a literal"],
		["DO $$ BEGIN EXECUTE 'UPDATE users SET note = ''WHERE'''; END $$;", "EXECUTE of a literal with a doubled quote"],
		["DO $$ BEGIN EXECUTE $q$TRUNCATE post$q$; END $$;", "EXECUTE of a dollar literal"],
		["DO 'BEGIN DELETE FROM users; END';", "a single-quoted DO body"],
		["DO LANGUAGE plpgsql 'BEGIN EXECUTE ''TRUNCATE post''; END';", "an EXECUTE in a single-quoted DO body"],
	])("calls %j unsafe (%s)", (sql) => {
		expect(pg(sql).safety).toBe("unsafe")
	})

	it.each([
		["ALTER SEQUENCE IF EXISTS s RESTART;", "a sequence restart with IF EXISTS"],
		["ALTER TABLE post NO FORCE ROW LEVEL SECURITY", "NO FORCE ROW LEVEL SECURITY"],
	])("calls %j cautious (%s)", (sql) => {
		expect(pg(sql).safety).toBe("cautious")
	})

	/* a function that is no pure built-in runs code comb cannot read, whoever created it (pg-tree.ts) */
	it("calls a function an earlier file created unsafe, as any that is no pure built-in", () => {
		const before = { ...schemaWith("users", ["id"]), functions: ["purge"] }
		expect(classifyMigration("SELECT purge();", { before, dialect: "postgres" }).safety).toBe("unsafe")
		expect(pg("SELECT purge();").safety).toBe("unsafe")
	})

	it.each([
		"DELETE FROM post WHERE id = 1",
		"DELETE FROM post WHERE id IN (SELECT id FROM gone)",
		"UPDATE post SET a = 1 WHERE id = 2",
		"MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a",
		"CREATE RULE r AS ON DELETE TO post DO INSTEAD (UPDATE post SET gone = true WHERE id = old.id)",
	])("calls %j, which may destroy existing values, unsafe", (sql) => {
		expect(pg(sql).safety).toBe("unsafe")
	})

	/* a SQLite REPLACE deletes the row it replaces: the proof's engine pass rates it unsafe (plan-apply.engine.test.ts) */

	it("rates a DO with no body unsafe, as every DO is", () => {
		expect(pg("DO").safety).toBe("unsafe")
	})
})

/* T9 of the 2.3 review: an unnamed dialect is SQLite, as the CLI's default is; a SQLite caller needs no Postgres parser */
describe("classifyMigration with no dialect named", () => {
	it("reads the file as SQLite, without the Postgres parser", async () => {
		vi.resetModules()
		const fresh = await import("./classify.ts")
		const parse = await import("./parse.ts")
		expect(fresh.classifyMigration("CREATE TABLE a (id int);").safety).toBe("safe")
		expect(fresh.classifyMigration("DROP TABLE post;").unsafeStatements).toEqual(["DROP TABLE post"])
		expect(fresh.extractDropStatements("DROP TABLE post")).toEqual(["DROP TABLE post"])
		expect(parse.parseMigration("CREATE TABLE a (id int);", "1.sql").classification.safety).toBe("safe")
	})

	it("reads it as SQLite would: what Postgres reads as a string, SQLite reads as code", () => {
		expect(classifyMigration("SELECT E'\\''; DROP TABLE post; -- ';").safety).toBe(
			classifyMigration("SELECT E'\\''; DROP TABLE post; -- ';", { dialect: "sqlite" }).safety,
		)
	})
})

describe("extractDropStatements", () => {
	it.each([
		['DROP TABLE a, "public"."post"', ["DROP TABLE a", "DROP TABLE public.post"]],
		["ALTER TABLE post DROP CONSTRAINT post_check", []],
		["DROP INDEX CONCURRENTLY idx_a", ["DROP INDEX idx_a"]],
		['DROP INDEX CONCURRENTLY IF EXISTS "public"."idx_a"', ["DROP INDEX public.idx_a"]],
		['ALTER TABLE "public"."post" DROP COLUMN "body", ADD COLUMN "c" text', ["DROP COLUMN public.post.body"]],
		["ALTER TABLE `post` DROP COLUMN `title`", ["DROP COLUMN post.title"]],
	])("names the drops of %j", (sql, drops) => {
		expect(extractDropStatements(sql, { dialect: "postgres" })).toEqual(drops)
	})
})

describe("lock warnings on Postgres", () => {
	it.each([
		["CREATE INDEX i ON post (a)", 1],
		["CREATE UNIQUE INDEX i ON public.post (a)", 1],
		["CREATE TABLE t (a int);\nCREATE INDEX i ON t (a);", 0],
		["-- atlas:txmode none\n\nCREATE INDEX CONCURRENTLY i ON post (a)", 0],
		["REINDEX TABLE post", 1],
		["ALTER TABLE post ADD COLUMN at timestamptz DEFAULT clock_timestamp()", 1],
		["ALTER TABLE post ADD COLUMN id2 uuid NOT NULL DEFAULT gen_random_uuid()", 1],
		["ALTER TABLE post ADD COLUMN at timestamptz DEFAULT now()", 0],
		["ALTER TABLE post ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES b (id)", 1],
		["ALTER TABLE post ADD CONSTRAINT c CHECK (a > 0) NOT VALID", 0],
		["ALTER TABLE post ALTER COLUMN a TYPE bigint", 1],
		["-- atlas:txmode none\n\nVACUUM FULL post", 1],
	])("warns %j %i time(s)", (sql, count) => {
		expect(pg(sql).lockWarnings).toHaveLength(count)
	})

	it("warns nothing on SQLite, which has no concurrent index", () => {
		expect(lite("CREATE INDEX i ON post (a)").lockWarnings).toEqual([])
	})
})

/* Atlas v1.3.0's SQLite output: a column change rebuilds the table */
const rebuild = (copied: string) => `PRAGMA foreign_keys = off;
CREATE TABLE \`new_post\` (\`id\` text NULL, \`title\` text NOT NULL, \`n\` integer NULL, PRIMARY KEY (\`id\`));
INSERT INTO \`new_post\` (${copied}) SELECT ${copied} FROM \`post\`;
DROP TABLE \`post\`;
ALTER TABLE \`new_post\` RENAME TO \`post\`;
PRAGMA foreign_keys = on;`

describe("classifyMigration on Atlas's SQLite table rebuild", () => {
	const before = schemaWith("post", ["id", "title", "n"])

	it("calls a rebuild that copies every earlier column cautious, and names no drop", () => {
		expect(lite(rebuild("`id`, `title`, `n`"), before).safety).toBe("cautious")
		expect(extractDropStatements(rebuild("`id`, `title`, `n`"), { before, dialect: "sqlite" })).toEqual([])
	})

	it("calls a rebuild that leaves an earlier column out unsafe, and names the column", () => {
		const sql = rebuild("`id`, `n`")
		expect(lite(sql, before).safety).toBe("unsafe")
		expect(extractDropStatements(sql, { before, dialect: "sqlite" })).toEqual(["DROP COLUMN post.title"])
		expect(lite(sql, before).unsafeStatements).toEqual(["DROP TABLE `post` (rebuilds post without title)"])
	})

	it("calls a rebuild of a table with no earlier definition unsafe", () => {
		expect(lite(rebuild("`id`, `title`, `n`")).safety).toBe("unsafe")
	})

	it.each(["ALTER TABLE `post` DROP COLUMN `title`", "ALTER TABLE a RENAME TO b", 'DROP TABLE "post"'])(
		"calls %j unsafe",
		(sql) => {
			expect(lite(sql).safety).toBe("unsafe")
		},
	)
})

/* Atlas v1.3.0's rebuild of post into a copy with defaults, its SELECT list and what follows its FROM given */
const copyRebuild = (
	select: string,
	rest = "",
	targets = "`id`, `title`, `n`",
) => `CREATE TABLE \`new_post\` (\`id\` text NULL, \`title\` text NOT NULL DEFAULT '', \`n\` integer NOT NULL DEFAULT (unixepoch() * 1000), PRIMARY KEY (\`id\`));
INSERT INTO \`new_post\` (${targets}) SELECT ${select} FROM \`post\`${rest};
DROP TABLE \`post\`;
ALTER TABLE \`new_post\` RENAME TO \`post\`;`

describe("classifyMigration on the copy of a rebuild", () => {
	const before = schemaWith("post", ["id", "title", "n"])
	const reasons = (sql: string) => lite(sql, before).unsafeStatements

	it.each([
		[
			"Atlas's IFNULL with each column's new default",
			"`id`, IFNULL(`title`, '') AS `title`, IFNULL(`n`, (unixepoch() * 1000)) AS `n`",
		],
		["a CAST of the same column", "`id`, CAST(`title` AS text) AS `title`, `n`"],
		["bare columns, quoted or not", 'id, `title`, "n"'],
	])("calls a copy through %s cautious", (_, select) => {
		expect(lite(copyRebuild(select), before)).toMatchObject({
			cautiousStatements: ["DROP TABLE `post` (rebuilds post, copying every column)"],
			safety: "cautious",
		})
	})

	it("calls a copy that carries rowid into rowid cautious", () => {
		expect(lite(copyRebuild("rowid, `id`, `title`, `n`", "", "rowid, `id`, `title`, `n`"), before).safety).toBe(
			"cautious",
		)
	})

	it.each([
		[" WHERE `n` > 1", "WHERE"],
		[" JOIN `u` ON 1", "JOIN"],
		[" LEFT JOIN `u` ON 1", "LEFT JOIN"],
		[" LIMIT 1", "LIMIT"],
		[" GROUP BY `id`", "GROUP BY"],
		[" ORDER BY `id`", "ORDER BY"],
		[", `u`", "a second table"],
		[" UNION SELECT `id`, `title`, `n` FROM `post`", "UNION"],
	])("calls a copy followed by %j unsafe, naming the clause", (rest, clause) => {
		expect(reasons(copyRebuild("`id`, `title`, `n`", rest))).toEqual([
			`DROP TABLE \`post\` (rebuilds post: its copy has ${clause})`,
		])
	})

	it.each([
		["`id`, NULL, `n`", "title from NULL"],
		["`id`, 'x' AS `title`, `n`", "title from 'x' AS `title`"],
		["`id`, `old` AS `title`, `n`", "title from `old` AS `title`"],
		["`id`, IFNULL(`title`, 'zz') AS `title`, `n`", "title from IFNULL(`title`, 'zz') AS `title`"],
		["`id`, IFNULL(`n`, '') AS `title`, `n`", "title from IFNULL(`n`, '') AS `title`"],
		["`id`, `title` AS `n`, `n`", "title from `title` AS `n`"],
		["`id`, CAST(`n` AS text) AS `title`, `n`", "title from CAST(`n` AS text) AS `title`"],
		["`id`, `title`, IFNULL(`n`, 0) AS `n`", "n from IFNULL(`n`, 0) AS `n`"],
	])("calls a copy of %j unsafe, naming the column and what fills it", (select, fills) => {
		expect(reasons(copyRebuild(select))).toEqual([`DROP TABLE \`post\` (rebuilds post: its copy fills ${fills})`])
	})
})

describe("classifyMigration on a copy that is no plain copy", () => {
	const before = schemaWith("post", ["id", "title", "n"])
	const reasons = (sql: string) => lite(sql, before).unsafeStatements

	it("reads a drop ahead of its copy as no guarded rebuild, its copy still read", () => {
		const early = copyRebuild("`id`, `title`, `n`").replace("DROP TABLE `post`;\n", "")
		const sql = early.replace("CREATE TABLE", "DROP TABLE `post`;\nCREATE TABLE")
		expect(lite(sql, before).cautiousStatements).toEqual(["DROP TABLE `post` (rebuilds post, copying every column)"])
	})

	it("calls a copy with a subquery or the wrong number of values unsafe", () => {
		expect(reasons(copyRebuild("`id`, (SELECT 1) AS `title`, `n`"))).toEqual([
			"DROP TABLE `post` (rebuilds post: its copy has a subquery)",
		])
		expect(reasons(copyRebuild("`id`, `title`"))).toEqual([
			"DROP TABLE `post` (rebuilds post: its copy has 2 values for 3 columns)",
		])
	})
})

describe("classifyMigration: each statement once", () => {
	it("lists a statement only at its strictest level", () => {
		expect(pg("DROP VIEW v CASCADE")).toMatchObject({
			cautiousStatements: [],
			unsafeStatements: ["DROP VIEW v CASCADE"],
		})
	})
})

describe("classifyMigration on a SQLite trigger that writes (M1)", () => {
	it("rates a trigger that deletes or nulls rows unsafe, as every later insert runs it", () => {
		for (const body of ["DELETE FROM users", "UPDATE users SET email = NULL"]) {
			const sql = `DROP TRIGGER IF EXISTS wipe;\nCREATE TRIGGER wipe AFTER INSERT ON users BEGIN ${body}; END;\nINSERT INTO users (email) VALUES ('x');`
			expect(classifyMigration(sql, { dialect: "sqlite" }).safety).toBe("unsafe")
		}
	})
})

/** The level the file's statement starting with `call` lands at (the routine itself is unsafe by default-deny) */
function levelOf(sql: string, call: string) {
	const rated = pg(sql)
	if (rated.unsafeStatements.some((entry) => entry.startsWith(call.replace(/;$/, "")))) return "unsafe"
	return rated.cautiousStatements.some((entry) => entry.startsWith(call.replace(/;$/, ""))) ? "cautious" : "safe"
}

describe("classifyMigration on a call of a routine the file creates (M2)", () => {
	const wipe = "CREATE FUNCTION wipe() RETURNS int AS $$ BEGIN DELETE FROM users; RETURN 1; END $$ LANGUAGE plpgsql;\n"

	it.each([
		["SELECT wipe();", "a SELECT"],
		["INSERT INTO log (n) VALUES (wipe());", "an INSERT's values"],
		["CREATE TABLE snap AS SELECT wipe() AS n;", "a CREATE TABLE AS"],
		["CREATE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION wipe();", "a trigger"],
	])("rates %j unsafe when the routine's body deletes rows (%s)", (call) => {
		expect(levelOf(`${wipe}${call}`, call)).toBe("unsafe")
		expect(pg(wipe).unsafeStatements.join("\n")).toMatch(/comb does not recognize CREATE FUNCTION/)
	})

	/* a routine's body is code comb does not read, in any language: its creation and every call are unsafe */
	it("rates every call of a routine the file creates unsafe, whatever its body or language", () => {
		for (const [routine, call] of [
			['CREATE PROCEDURE "p"() LANGUAGE sql AS $$ SELECT 1 $$;', 'CALL "p"()'],
			['CREATE PROCEDURE "p"() LANGUAGE sql AS $$ SELECT 1 $$;', 'SELECT "p"()'],
			["CREATE FUNCTION py() RETURNS int LANGUAGE plpython3u AS $$ return 1 $$;", "SELECT py()"],
		])
			expect(levelOf(`${routine}\n${call};`, call)).toBe("unsafe")
	})
})

/** Atlas's rebuild of t into a new table of `columns`, copying id, code and note */
const rebuildTo = (columns: string, tail = "") =>
	`CREATE TABLE new_t (${columns})${tail};\nINSERT INTO new_t (id, code, note) SELECT id, code, note FROM t;\nDROP TABLE t;\nALTER TABLE new_t RENAME TO t;`

/** Atlas's rebuild of g, copying id and a, into a new table whose up is `up` */
const generatedCopy = (up: string) =>
	`CREATE TABLE new_g (id INTEGER PRIMARY KEY, a TEXT, up ${up});\nINSERT INTO new_g (id, a) SELECT id, a FROM g;\nDROP TABLE g;\nALTER TABLE new_g RENAME TO g;`

describe("classifyMigration on a SQLite rebuild whose new table changes what lands (M5, M13)", () => {
	const before = extractSchema("CREATE TABLE t (id INTEGER PRIMARY KEY, code TEXT, note varchar(20));")
	const rate = (sql: string) => lite(sql, before)

	it.each([
		["id INTEGER PRIMARY KEY, code INTEGER, note text", "", "changes code's affinity from TEXT to INTEGER"],
		["id INTEGER PRIMARY KEY, code TEXT UNIQUE ON CONFLICT IGNORE, note text", "", "adds ON CONFLICT code: IGNORE"],
		["id INTEGER PRIMARY KEY, code TEXT NOT NULL ON CONFLICT IGNORE, note text", "", "adds ON CONFLICT code: IGNORE"],
		[
			"id INTEGER PRIMARY KEY, code TEXT NOT NULL ON CONFLICT REPLACE DEFAULT 'gone', note text",
			"",
			"adds ON CONFLICT code: REPLACE",
		],
		[
			"id INTEGER PRIMARY KEY, code TEXT, note text, UNIQUE (code, note) ON CONFLICT REPLACE",
			"",
			"adds ON CONFLICT code,note: REPLACE",
		],
		["id INTEGER PRIMARY KEY, code TEXT, note TEXT", " STRICT", "makes the table STRICT"],
	])("rates a rebuild to (%s)%s unsafe: %s", (columns, tail, note) => {
		const read = rate(rebuildTo(columns, tail))
		expect(read.safety).toBe("unsafe")
		expect(read.unsafeStatements.join("\n")).toContain(note)
	})

	it("keeps a rebuild that keeps each affinity cautious: varchar to text, integer to INT", () => {
		expect(rate(rebuildTo("id INT PRIMARY KEY, code text NOT NULL DEFAULT '', note TEXT")).safety).toBe("cautious")
	})

	it("leaves out a generated column the new table still generates, and counts one it no longer does (M13)", () => {
		const generated = extractSchema(
			"CREATE TABLE g (id INTEGER PRIMARY KEY, a TEXT, up TEXT GENERATED ALWAYS AS (upper(a)) VIRTUAL);",
		)
		expect(lite(generatedCopy("TEXT GENERATED ALWAYS AS (upper(a)) VIRTUAL"), generated).safety).toBe("cautious")
		const plain = lite(generatedCopy("TEXT"), generated)
		expect(plain.safety).toBe("unsafe")
		expect(plain.unsafeStatements.join("\n")).toContain("rebuilds g without up")
	})
})
