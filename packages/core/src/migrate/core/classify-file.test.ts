import { describe, expect, it } from "vitest"
import type { ExtractedSchema } from "../types.ts"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const pg = (sql: string) => classifyMigration(sql, { dialect: "postgres" })
const lite = (sql: string, before?: ExtractedSchema) => classifyMigration(sql, { before, dialect: "sqlite" })

describe("classifyMigration on a statement that runs only outside a transaction", () => {
	it.each([
		"CREATE INDEX CONCURRENTLY i ON post (a)",
		"-- atlas:txmode none\nCREATE INDEX CONCURRENTLY i ON post (a);",
		"DROP INDEX CONCURRENTLY i",
		"REINDEX TABLE CONCURRENTLY post",
		"VACUUM post",
		"-- comb:allow-unsafe: maintenance\nVACUUM post",
	])("refuses %j outside an -- atlas:txmode none file, whatever the approval", (sql) => {
		expect(() => pg(sql)).toThrow(/-- atlas:txmode none/)
	})

	it("accepts each of them in an -- atlas:txmode none file, and refuses VACUUM on SQLite", () => {
		expect(pg("-- atlas:txmode none\n\nVACUUM post;\nDROP INDEX CONCURRENTLY i;").safety).toBe("cautious")
		expect(() => lite("VACUUM")).toThrow("VACUUM")
	})
})

/* P8 of r19: read from the parse tree, each as Postgres 17 refused it in a transaction (.tmp/grunt/p18/runs/8954e05-probe-p8-*.log) */
describe("classifyMigration on every statement Postgres 17 runs only outside a transaction", () => {
	it.each([
		["ALTER TABLE ev DETACH PARTITION ev_old CONCURRENTLY", "ALTER TABLE ... DETACH CONCURRENTLY"],
		["CLUSTER", "CLUSTER"],
		["VACUUM (ANALYZE) post", "VACUUM"],
		["REINDEX (CONCURRENTLY) TABLE post", "REINDEX CONCURRENTLY"],
		["REINDEX SCHEMA public", "REINDEX SCHEMA"],
		["REINDEX DATABASE app", "REINDEX DATABASE"],
		["REINDEX SYSTEM", "REINDEX SYSTEM"],
		["ALTER SYSTEM SET work_mem = '4MB'", "ALTER SYSTEM"],
		["CREATE DATABASE other", "CREATE DATABASE"],
		["DROP DATABASE IF EXISTS other", "DROP DATABASE"],
		["ALTER DATABASE app SET TABLESPACE fast", "ALTER DATABASE SET TABLESPACE"],
		["CREATE TABLESPACE fast LOCATION '/data'", "CREATE TABLESPACE"],
		["DROP TABLESPACE IF EXISTS fast", "DROP TABLESPACE"],
		["DISCARD ALL", "DISCARD ALL"],
		["COMMIT PREPARED 'x'", "COMMIT PREPARED"],
		["ROLLBACK PREPARED 'x'", "ROLLBACK PREPARED"],
		["CREATE SUBSCRIPTION s CONNECTION 'host=p' PUBLICATION p", "CREATE SUBSCRIPTION ... WITH (create_slot = true)"],
		["CREATE SUBSCRIPTION s CONNECTION 'host=p' PUBLICATION p WITH (create_slot = on)", "CREATE SUBSCRIPTION"],
		["DROP SUBSCRIPTION s", "DROP SUBSCRIPTION"],
		["ALTER SUBSCRIPTION s REFRESH PUBLICATION WITH (copy_data = false)", "ALTER SUBSCRIPTION ... REFRESH"],
		["ALTER SUBSCRIPTION s SET PUBLICATION p", "ALTER SUBSCRIPTION with refresh"],
		["ALTER SUBSCRIPTION s ADD PUBLICATION p WITH (refresh = true)", "ALTER SUBSCRIPTION with refresh"],
	])(
		"refuses %j outside an -- atlas:txmode none file, naming it as Postgres does, and runs it in one",
		(sql, named) => {
			expect(() => pg(sql)).toThrow(`Postgres runs ${named}`)
			expect(() => pg(`-- atlas:txmode none\n\n${sql};`)).not.toThrow()
		},
	)

	it.each([
		"ANALYZE post",
		"CLUSTER post USING post_pkey",
		"REINDEX TABLE post",
		"ALTER TABLE ev DETACH PARTITION ev_old",
		"ALTER TABLE ev DETACH PARTITION ev_old FINALIZE",
		"CREATE SUBSCRIPTION s CONNECTION 'host=p' PUBLICATION p WITH (connect = false)",
		"CREATE SUBSCRIPTION s CONNECTION 'host=p' PUBLICATION p WITH (create_slot = off)",
		"CREATE SUBSCRIPTION s CONNECTION 'host=p' PUBLICATION p WITH (create_slot = 0)",
		"ALTER SUBSCRIPTION s SET PUBLICATION p WITH (refresh = false)",
		"ALTER SUBSCRIPTION s ENABLE",
		"ALTER DATABASE app SET work_mem = '4MB'",
		"DISCARD PLANS",
		"ALTER TYPE mood ADD VALUE 'c'",
		"COMMENT ON TABLE post IS 'VACUUM; CLUSTER; REINDEX SCHEMA public'",
	])("lets %j run in a transaction, as Postgres does", (sql) => {
		expect(() => pg(sql)).not.toThrow()
	})
})

/* r18 S2: SQLite will not change the journal mode inside the transaction comb runs each file in */
describe("classifyMigration on SQLite's journal_mode", () => {
	it.each([
		"PRAGMA journal_mode = WAL",
		"PRAGMA main.journal_mode=wal",
		'PRAGMA "main" . JOURNAL_MODE = DELETE',
		"PRAGMA journal_mode",
		"-- comb:allow-unsafe: needed\nCREATE TABLE z (id INTEGER PRIMARY KEY);\nPRAGMA journal_mode = WAL;",
	])("refuses %j, whatever the approval", (sql) => {
		expect(() => lite(sql)).toThrow("journal_mode is the database's setting")
	})

	it("rates a statement that only reads the mode, or names a table after it, as any other", () => {
		expect(lite("SELECT journal_mode FROM pragma_journal_mode").safety).toBe("safe")
		expect(lite("CREATE TABLE journal_mode_log (id INTEGER PRIMARY KEY)").safety).toBe("safe")
	})
})

/*
 * S1 of r19: a pragma's name read once, quoted or not, against a table of what each target refuses, with no override:
 * SQLite inside the transaction comb runs each file in, and D1's authorizer (wrangler --local, .tmp/grunt/p18/d1-pragma-probe.log)
 */
const d1 = (sql: string) => classifyMigration(sql, { d1: true, dialect: "sqlite" } as never)
describe("classifyMigration on a pragma SQLite refuses inside a transaction, however its name is spelled", () => {
	it.each([
		'PRAGMA "journal_mode" = WAL',
		"PRAGMA [journal_mode] = WAL",
		"PRAGMA `journal_mode` = WAL",
		'PRAGMA main."journal_mode" = WAL',
		"PRAGMA journal_mode(WAL)",
		"PRAGMA synchronous = OFF",
		'PRAGMA "synchronous" = NORMAL',
		"PRAGMA main.synchronous(0)",
		"PRAGMA query_only = 1",
		"PRAGMA [query_only] = ON",
		/* S2 of r20: query_only with a value in any form, as SQLite reads it, off included */
		"PRAGMA query_only = '1'",
		"PRAGMA query_only = 01",
		'PRAGMA query_only = "on"',
		"PRAGMA query_only = 'on'",
		"PRAGMA query_only(yes)",
		"PRAGMA query_only = 0",
		"PRAGMA query_only = 'off'",
		"PRAGMA wal_checkpoint",
		"PRAGMA wal_checkpoint(TRUNCATE)",
		"-- comb:allow-unsafe: needed\nCREATE TABLE z (id INTEGER PRIMARY KEY);\nPRAGMA synchronous = OFF;",
	])("refuses %j, whatever the approval, on every SQLite target", (sql) => {
		expect(() => lite(sql)).toThrow(/inside the transaction comb runs each file in/)
		expect(() => d1(sql)).toThrow()
	})

	it.each(["PRAGMA synchronous", "PRAGMA query_only", 'PRAGMA "temp_store" = MEMORY'])(
		"rates %j, which SQLite runs inside one, as any other pragma",
		(sql) => {
			expect(lite(sql).safety).toBe("unsafe")
		},
	)
})

describe("classifyMigration on the foreign-key pragmas comb writes, however their names are spelled", () => {
	it.each([
		"PRAGMA defer_foreign_keys = on",
		'PRAGMA "defer_foreign_keys" = 1',
		"PRAGMA main.[defer_foreign_keys] = true",
		"PRAGMA defer_foreign_keys = 'on'",
	])("rates %j safe, as comb writes it", (sql) => {
		expect(lite(sql).safety).toBe("safe")
	})

	/* S2 of r20: SQLite reads a single-quoted value as the value, so every rule reads it unquoted, and a value it
	   does not know as off; inside comb's transaction each is a no-op, so the note is its only finding, and any value
	   but on, yes, true and 1 gets it, however a SQLite version reads it */
	it.each([
		"PRAGMA foreign_keys = 'off'",
		"PRAGMA foreign_keys = 'false'",
		"PRAGMA foreign_keys = 'nope'",
		"PRAGMA foreign_keys = full",
		"PRAGMA foreign_keys = 256",
		"PRAGMA foreign_keys = 2",
	])("notes %j, which comb does not write as on", (sql) => {
		expect([lite(sql).safety, lite(sql).cautiousStatements.length]).toEqual(["cautious", 1])
	})

	it.each(["PRAGMA foreign_keys = +1", "PRAGMA foreign_keys = 'yes'", "PRAGMA foreign_keys = TRUE"])(
		"rates %j, which comb writes as on, safe",
		(sql) => {
			expect(lite(sql).safety).toBe("safe")
		},
	)

	it.each(["PRAGMA defer_foreign_keys", "PRAGMA temp.defer_foreign_keys = on", "PRAGMA defer_foreign_keys = 2"])(
		"rates %j, which comb does not write, as any other pragma",
		(sql) => {
			expect(lite(sql).safety).toBe("unsafe")
		},
	)
})

describe("classifyMigration on a pragma D1 does not authorize", () => {
	it.each([
		"PRAGMA temp_store = MEMORY",
		'PRAGMA "cache_size" = 10',
		"PRAGMA main.secure_delete = 1",
		"PRAGMA [user_version] = 3",
		"PRAGMA page_size = 8192",
		"PRAGMA integrity_check",
		"-- comb:allow-unsafe: needed\nPRAGMA busy_timeout = 100;",
	])("refuses %j, whatever the approval, naming D1's list", (sql) => {
		expect(() => d1(sql)).toThrow(/D1 runs only the pragmas it authorizes/)
		expect(() => lite(sql)).not.toThrow()
	})

	it.each([
		"PRAGMA defer_foreign_keys = on",
		'PRAGMA "foreign_keys" = OFF',
		'PRAGMA table_info("post")',
		"PRAGMA main.index_list(post)",
		"PRAGMA optimize",
		"PRAGMA page_size",
		"PRAGMA data_version",
		"PRAGMA legacy_alter_table = 1",
	])("lets %j, which D1 authorizes, through to its rating", (sql) => {
		expect(() => d1(sql)).not.toThrow()
	})
})

/* S1 of the 0.15.0 review: a file's own transaction control ends the batch that records it */
describe("classifyMigration on SQLite transaction control", () => {
	it.each([
		"INSERT INTO post (body) VALUES ('x');\nCOMMIT;\nBEGIN;\nCREATE UNIQUE INDEX u ON post (body);",
		"CREATE TABLE z (id INTEGER PRIMARY KEY);\nCOMMIT TRANSACTION;",
		"END;\nCREATE TABLE z (id INTEGER PRIMARY KEY);\nBEGIN;",
		"BEGIN IMMEDIATE;\nCREATE TABLE z (id INTEGER PRIMARY KEY);",
		"CREATE TABLE z (id INTEGER PRIMARY KEY);\nROLLBACK;",
		"CREATE TABLE z (id INTEGER PRIMARY KEY);\nROLLBACK TRANSACTION;",
		"START TRANSACTION;\nCREATE TABLE z (id INTEGER PRIMARY KEY);",
		"-- comb:allow-unsafe: wrapped by hand\nBEGIN TRANSACTION;\nCREATE TABLE z (id INTEGER PRIMARY KEY);\nCOMMIT;",
	])("refuses %j, whatever the approval", (sql) => {
		expect(() => lite(sql)).toThrow("comb runs each file in a transaction of its own")
	})

	it("rates a savepoint, its release and a rollback to it, which nest inside the file's transaction", () => {
		expect(
			lite("SAVEPOINT s;\nCREATE TABLE z (id INTEGER PRIMARY KEY);\nROLLBACK TRANSACTION TO SAVEPOINT s;\nRELEASE s;")
				.safety,
		).toBe("safe")
	})
})

describe("classifyMigration on comb's FTS regroup", () => {
	it("calls the drop of an external-content FTS index cautious when the file creates it again and rebuilds it", () => {
		const regroup = `DROP TRIGGER IF EXISTS post_fts_ai;
DROP TABLE IF EXISTS post_fts;
CREATE VIRTUAL TABLE IF NOT EXISTS post_fts USING fts5(title, content='post', content_rowid='id');
INSERT INTO post_fts(post_fts) VALUES ('rebuild');`
		/* the history comb's FTS migration left: the index and its sync trigger */
		const external = extractSchema(
			"CREATE TABLE post (id INTEGER PRIMARY KEY, title TEXT);\nCREATE VIRTUAL TABLE post_fts USING fts5(title, content='post', content_rowid='id');\nCREATE TRIGGER post_fts_ai AFTER INSERT ON post BEGIN INSERT INTO post_fts(rowid, title) VALUES (new.id, new.title); END;",
		)
		expect(lite(regroup, external).safety).toBe("cautious")
		expect(lite(regroup.replace("content='post', ", ""), external).safety).toBe("unsafe")
		expect(lite(regroup.replace(/INSERT INTO[^\n]*/, "")).safety).toBe("unsafe")
		expect(lite("DROP TABLE IF EXISTS post_fts, post;\n" + regroup.split("\n").slice(2).join("\n")).safety).toBe(
			"unsafe",
		)
	})
})

describe("classifyMigration on an FTS5 command", () => {
	it.each([
		"INSERT INTO post_fts(post_fts) VALUES ('delete-all');",
		"INSERT INTO \"post_fts\" ( \"post_fts\", rowid, title ) VALUES ( 'delete', 1, 'x' );",
		"INSERT INTO post_fts(post_fts) SELECT 'delete-all';",
		"INSERT INTO post_fts(post_fts) VALUES (lower('DELETE-ALL'));",
		"INSERT INTO post_fts(post_fts) VALUES ('rebuild'), ('delete-all');",
		/* M42: every spelling of an insert into the table's own column is a command */
		"INSERT OR IGNORE INTO post_fts(post_fts) VALUES ('delete-all');",
		"INSERT OR ABORT INTO post_fts(post_fts) VALUES ('delete-all');",
		"INSERT OR ROLLBACK INTO post_fts(post_fts) VALUES ('delete-all');",
		"INSERT OR FAIL INTO post_fts(post_fts) VALUES ('delete-all');",
		"INSERT OR REPLACE INTO post_fts(post_fts) VALUES ('delete-all');",
		"REPLACE INTO post_fts(post_fts) VALUES ('delete-all');",
		"WITH x AS (SELECT 1) INSERT INTO post_fts(post_fts) VALUES ('delete-all');",
		"WITH x AS (SELECT 'delete-all' AS c) INSERT OR IGNORE INTO main.post_fts(post_fts) SELECT c FROM x;",
	])("calls %j unsafe: it removes indexed rows, or comb cannot read which command it runs", (sql) => {
		expect(lite(sql).unsafeStatements.join("\n")).toContain("FTS5 command")
	})

	it.each([
		"INSERT INTO post_fts(post_fts) VALUES ('rebuild');",
		"INSERT INTO post_fts(post_fts, rank) VALUES ('merge', 500);",
		"INSERT INTO post_fts(post_fts, rank) VALUES ('rank', 'bm25(10.0, 5.0)');",
		"INSERT INTO post_fts(post_fts) VALUES('optimize');",
		"INSERT INTO post_fts(title) VALUES ('x');",
		"INSERT OR IGNORE INTO post_fts(post_fts) VALUES ('rebuild');",
		"WITH x AS (SELECT 1) INSERT INTO post_fts(post_fts) VALUES ('optimize');",
	])("leaves %j to the other rules: it keeps every indexed row", (sql) => {
		expect(lite(sql).unsafeStatements).toEqual([])
	})
})

describe("classifyMigration on a drop of an FTS5 table that stored its own text (M8)", () => {
	it("rates it unsafe though the file recreates it as an external-content index of an empty table", () => {
		const stored = extractSchema(
			"CREATE TABLE src (id integer PRIMARY KEY, body text);\nCREATE VIRTUAL TABLE notes USING fts5(body);",
		)
		const replaced = `DROP TABLE notes;
CREATE VIRTUAL TABLE notes USING fts5(body, content='src', content_rowid='id');
INSERT INTO notes(notes) VALUES ('rebuild');`
		expect(lite(replaced, stored).safety).toBe("unsafe")
		expect(lite(replaced).safety).toBe("unsafe")
		const contentless = extractSchema("CREATE VIRTUAL TABLE notes USING fts5(body, content='');")
		expect(contentless.externalFts).toEqual(["notes"])
		expect(lite(replaced, contentless).safety).toBe("cautious")
	})
})

describe("classifyMigration on a SQLite pragma", () => {
	it.each([
		["PRAGMA writable_schema = 1;", "unsafe"],
		["PRAGMA ignore_check_constraints = on;", "unsafe"],
		["PRAGMA foreign_keys = off;", "cautious"],
		["PRAGMA defer_foreign_keys = on;", "safe"],
	])("rates %j %s: only the two foreign-key pragmas are shapes comb recognizes", (sql, safety) => {
		expect(lite(sql).safety).toBe(safety)
	})
})
