import { describe, expect, it } from "vitest"
import type { ExtractedSchema } from "../types.ts"
import { classifyMigration, extractDropStatements } from "./classify.ts"

const pg = (sql: string) => classifyMigration(sql, { dialect: "postgres" })
const lite = (sql: string, before?: ExtractedSchema) => classifyMigration(sql, { before, dialect: "sqlite" })
const schemaWith = (table: string, columns: string[]): ExtractedSchema => ({
	droppedTables: [],
	foreignKeys: [],
	functions: [],
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
		"DROP POLICY p ON post",
		"DROP TRIGGER t ON post",
		"DROP FUNCTION f()",
		"MERGE INTO t USING s ON t.id = s.id WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)",
		"CREATE OR REPLACE VIEW v AS SELECT 1",
		"CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql",
		"GRANT SELECT ON post TO r",
		"REVOKE SELECT ON post FROM r",
		"CALL p()",
		"ALTER SEQUENCE s RESTART",
		"ALTER INDEX i RENAME TO j",
		"ALTER TABLE post DISABLE ROW LEVEL SECURITY",
		"ALTER TABLE post DISABLE TRIGGER ALL",
		"ALTER TABLE post SET UNLOGGED",
		"ALTER TABLE post ALTER COLUMN id DROP IDENTITY",
		"-- atlas:txmode none\n\nCREATE INDEX CONCURRENTLY i ON post (a);",
		"DO $$ BEGIN EXECUTE format('DROP TABLE %I', 'post'); END $$",
	])("calls %j cautious", (sql) => {
		expect(pg(sql).safety).toBe("cautious")
	})

	it.each([
		"ALTER TYPE mood ADD VALUE 'c'",
		"ALTER TABLE post ADD COLUMN x text NOT NULL DEFAULT ''",
		"ALTER TABLE post ADD COLUMN n bigint NOT NULL GENERATED ALWAYS AS IDENTITY",
		"ALTER TABLE post ALTER COLUMN a SET DEFAULT 1",
		"CREATE FUNCTION f() RETURNS void AS $$ DROP TABLE post $$ LANGUAGE sql",
		"CREATE TABLE child (id int REFERENCES parent (id) ON DELETE CASCADE)",
		"ALTER TABLE post ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES b (id) ON DELETE CASCADE NOT VALID",
		"SELECT 'DROP TABLE post'",
	])("calls %j safe", (sql) => {
		expect(pg(sql).safety).toBe("safe")
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
		[
			"CREATE FUNCTION purge() RETURNS void LANGUAGE sql AS $$ DELETE FROM users $$;\nSELECT purge();",
			"a call of a function the file creates",
		],
		['CREATE PROCEDURE "p"() LANGUAGE sql AS $$ SELECT 1 $$;\nPERFORM "p"();', "a PERFORM"],
		["ALTER TABLE post NO FORCE ROW LEVEL SECURITY", "NO FORCE ROW LEVEL SECURITY"],
	])("calls %j cautious (%s)", (sql) => {
		expect(pg(sql).safety).toBe("cautious")
	})

	it("calls a function an earlier file created cautious", () => {
		const before = { ...schemaWith("users", ["id"]), functions: ["purge"] }
		expect(classifyMigration("SELECT purge();", { before, dialect: "postgres" }).safety).toBe("cautious")
		expect(pg("SELECT purge();").safety).toBe("safe")
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

	it.each(["REPLACE INTO t VALUES (1)", "INSERT OR REPLACE INTO t VALUES (1)"])(
		"calls %j, which deletes the row it replaces, unsafe on SQLite",
		(sql) => {
			expect(lite(sql).safety).toBe("unsafe")
		},
	)

	it("reads a DO with no body as running nothing", () => {
		expect(pg("DO").safety).toBe("safe")
	})
})

describe("classifyMigration with no dialect named", () => {
	it("reads the file both ways and keeps the stricter, so Postgres SQL never gets SQLite's reading", () => {
		expect(classifyMigration("SELECT E'\\''; DROP TABLE post; -- ';").safety).toBe("unsafe")
		expect(classifyMigration("DO $$ BEGIN DROP TABLE post; END $$;").safety).toBe("unsafe")
		expect(extractDropStatements("DO $$ BEGIN DROP TABLE post; END $$;")).toEqual(["DROP TABLE post"])
		expect(classifyMigration("SELECT E'\\''; DROP TABLE post; -- ';", { dialect: "sqlite" }).safety).toBe("safe")
	})

	it("keeps each finding once when both readings agree", () => {
		const both = classifyMigration("DROP TABLE post; CREATE INDEX i ON t (a);")
		expect(both.unsafeStatements).toEqual(["DROP TABLE post"])
		expect(both.lockWarnings).toHaveLength(1)
		expect(extractDropStatements("DROP TABLE post")).toEqual(["DROP TABLE post"])
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
		expect(pg("DROP FUNCTION f CASCADE")).toMatchObject({
			cautiousStatements: [],
			unsafeStatements: ["DROP FUNCTION f CASCADE"],
		})
	})
})
