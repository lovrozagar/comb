import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { refuseDrift, refuseObjectDrift, sqliteDrift } from "./baseline-compare.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import type { Run } from "./process.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-baseline-compare-"))
	mkdirSync(join(dir, "m"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** atlas: hash writes nothing; schema diff keeps the database's DDL it was handed and answers `stdout` */
function atlas(stdout: string, code = 0, notice = ""): Run & { live: string[] } {
	const live: string[] = []
	const run: Run = (_cmd, args) => {
		const from = args[args.indexOf("--from") + 1] as string
		if (args[0] === "schema" && from.startsWith("file://")) live.push(readFileSync(from.replace("file://", ""), "utf8"))
		if (args[0] !== "schema") return { code: 0, stderr: "", stdout: "" }
		return { code, stderr: code === 0 ? notice : "boom", stdout }
	}
	return Object.assign(run, { live })
}

describe("sqliteDrift", () => {
	it("hands Atlas the database without its FTS objects, shadow tables or history, and names each FTS object only one side has", async () => {
		writeFileSync(join(dir, "m", "1_init.sql"), "CREATE TABLE post (id TEXT, title TEXT);")
		const conn = libsqlConnection()
		await conn.client.executeMultiple(
			"CREATE TABLE post (id TEXT, title TEXT); CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY); CREATE VIRTUAL TABLE post_fts USING fts5(title, content='post'); CREATE TRIGGER post_fts_ai AFTER INSERT ON post BEGIN INSERT INTO post_fts(rowid, title) VALUES (new.rowid, new.title); END;",
		)
		const run = atlas("Schemas are synced, no changes to be made.\n")
		expect(await sqliteDrift(conn, join(dir, "m"), run)).toBe(
			"-- FTS table post_fts: only in the database\n-- trigger post_fts_ai: only in the database",
		)
		expect(run.live).toEqual(["CREATE TABLE post (id TEXT, title TEXT);\n"])
		await expect(sqliteDrift(conn, join(dir, "m"), atlas("", 1))).rejects.toThrow("atlas schema diff failed: boom")
		await conn.close()
	})
})

/* M79: Atlas's answer is compared as Atlas wrote it, and scrubbed only where comb prints it */
/** A Postgres target whose password is `password` */
const target = (password: string) => ({
	devUrl: "postgres://localhost/dev",
	lockTimeout: "5s",
	schema: "public",
	url: `postgres://app:${password}@db/app`,
})

describe("refuseDrift: the Postgres database against its replayed history", () => {
	it("finds a synced database synced whatever its password spells, and prints a difference scrubbed", () => {
		writeFileSync(join(dir, "m", "1_a.sql"), 'CREATE TABLE "a" ("id" int);\n')
		for (const password of ["synced", "are", "changes"]) {
			const exec = atlas("Schemas are synced, no changes to be made.\n")
			expect(() => refuseDrift({ exec, target: target(password) }, join(dir, "m"))).not.toThrow()
		}
		/* what Atlas says as it succeeds comes back, scrubbed, for baseline to warn with (plan 14's 5.4) */
		const said = atlas("Schemas are synced, no changes to be made.\n", 0, "Skipped triggers on synced\n")
		expect(refuseDrift({ exec: said, target: target("synced") }, join(dir, "m"))).toEqual(["Skipped triggers on ***"])
		const drifted = atlas('-- Modify "a" table: synced\nALTER TABLE "a" ADD COLUMN "x" int;\n')
		expect(() => refuseDrift({ exec: drifted, target: target("synced") }, join(dir, "m"))).toThrow(
			'the difference:\n-- Modify "a" table: ***\nALTER TABLE "a" ADD COLUMN "x" int;',
		)
	})
})

/* S5 of the 0.14.1 review: Atlas OSS inspects no SQLite trigger or view, and FTS was compared by name alone */
/** atlas finding the tables in sync */
const synced = () => atlas("Schemas are synced, no changes to be made.\n")

describe("sqliteDrift: the triggers, views and FTS tables Atlas OSS does not compare", () => {
	const HISTORY = `CREATE TABLE post (id TEXT, title TEXT, body TEXT);
CREATE VIRTUAL TABLE post_fts USING fts5(title, body, content='post');
CREATE TRIGGER post_audit AFTER UPDATE ON post BEGIN SELECT 1; END;`

	it("names a trigger only the migrations make, a view only the database has, and an FTS table whose columns differ", async () => {
		writeFileSync(join(dir, "m", "1_init.sql"), HISTORY)
		const conn = libsqlConnection()
		await conn.client.executeMultiple(
			"CREATE TABLE post (id TEXT, title TEXT, body TEXT); CREATE VIRTUAL TABLE post_fts USING fts5(title, content='post'); CREATE VIEW recent AS SELECT id FROM post;",
		)
		expect((await sqliteDrift(conn, join(dir, "m"), synced())).split("\n")).toEqual([
			"-- FTS table post_fts: the database has CREATE VIRTUAL TABLE post_fts USING fts5(title, content='post'), the migrations CREATE VIRTUAL TABLE post_fts USING fts5(title, body, content='post')",
			"-- view recent: only in the database",
			"-- trigger post_audit: only in the migrations",
		])
		await conn.close()
	})

	it("names a virtual table other than FTS5 as one, and refuses a history it cannot replay, naming the file", async () => {
		writeFileSync(join(dir, "m", "1_init.sql"), "CREATE VIRTUAL TABLE spots USING rtree(id, x0, x1);")
		const conn = libsqlConnection()
		expect(await sqliteDrift(conn, join(dir, "m"), synced())).toBe("-- virtual table spots: only in the migrations")
		writeFileSync(join(dir, "m", "2_bad.sql"), "CREATE TABLE ;")
		await expect(sqliteDrift(conn, join(dir, "m"), synced())).rejects.toThrow(
			"comb could not replay 2_bad.sql to compare its triggers and views:",
		)
		await conn.close()
	})

	/* the negative control: SQLite rewrites sqlite_master's text on a rename, on the database and on the replay alike */
	it("finds an FTS5 table and its sync triggers in sync after a rename SQLite rewrote their text for", async () => {
		const files = {
			"1_init.sql": `CREATE TABLE post (id INTEGER PRIMARY KEY, title TEXT);
CREATE VIRTUAL TABLE post_fts USING fts5(title, content='post', content_rowid='id');
CREATE TRIGGER post_fts_ai AFTER INSERT ON post BEGIN INSERT INTO post_fts(rowid, title) VALUES (new.id, new.title); END;
CREATE TRIGGER post_fts_ad AFTER DELETE ON post BEGIN INSERT INTO post_fts(post_fts, rowid, title) VALUES ('delete', old.id, old.title); END;`,
			"2_rename.sql": "ALTER TABLE post RENAME COLUMN id TO post_id;",
		}
		const conn = libsqlConnection()
		for (const [name, sql] of Object.entries(files)) {
			writeFileSync(join(dir, "m", name), sql)
			await conn.client.executeMultiple(sql)
		}
		expect(await sqliteDrift(conn, join(dir, "m"), synced())).toBe("")
		await conn.close()
	})

	it("finds the objects the migrations leave, whatever their whitespace and comments, in sync", async () => {
		writeFileSync(join(dir, "m", "1_init.sql"), HISTORY)
		const conn = libsqlConnection()
		await conn.client.executeMultiple(
			"CREATE TABLE post (id TEXT, title TEXT, body TEXT); CREATE VIRTUAL TABLE post_fts USING fts5(title,   body, content='post'); CREATE TRIGGER post_audit AFTER UPDATE ON post BEGIN /* kept */ SELECT 1; END;",
		)
		expect(await sqliteDrift(conn, join(dir, "m"), synced())).toBe("")
		await conn.close()
	})
})

/* P21 of the 0.14.1 review: each kind counted apart, and its noun as many as it counts */
describe("refuseObjectDrift: the warning over the bodies it did not compare", () => {
	beforeAll(loadPostgresParser)

	it.each([
		[["f"], [], "1 function"],
		[[], ["t_a", "t_b"], "2 triggers"],
	])("counts %j and %j as %s", async (functions, triggers, counted) => {
		const history = [
			'CREATE TABLE t ("id" int);',
			...functions.map((name) => `CREATE FUNCTION ${name}() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`),
			...triggers.map((name) => `CREATE TRIGGER ${name} AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION g();`),
		]
		writeFileSync(join(dir, "m", "1_init.sql"), history.join("\n"))
		const out: string[] = []
		const readLive = async () => ({
			routines: new Map(functions.map((name) => [name, { kind: "function" as const, signatures: new Set([""]) }])),
			triggers: new Map(
				triggers.length === 0 ? [] : [["t", new Map(triggers.map((name) => [name, { enabled: true, type: 5 }]))]],
			),
		})
		await refuseObjectDrift({ print: (line) => out.push(line), readLive, target: target("x") }, join(dir, "m"))
		expect(out).toEqual([
			`Warning: the bodies of ${counted} were not compared: Atlas OSS cannot load them, and comb does not read them`,
		])
	})
})

/* N-S5 of plan 15's rerun: Atlas OSS refuses what it cannot inspect */
describe("sqliteDrift: what Atlas OSS is handed", () => {
	it("hands Atlas neither side's virtual table, which it compares itself", async () => {
		writeFileSync(
			join(dir, "m", "1_init.sql"),
			"CREATE TABLE post (id TEXT);\nCREATE VIRTUAL TABLE spots USING rtree(id, x0, x1);",
		)
		const conn = libsqlConnection()
		await conn.client.executeMultiple(
			"CREATE TABLE post (id TEXT); CREATE VIRTUAL TABLE spots USING rtree(id, x0, x1);",
		)
		const run = atlas("Schemas are synced, no changes to be made.\n")
		expect(await sqliteDrift(conn, join(dir, "m"), run)).toBe("")
		expect(run.live.join("")).not.toContain("spots")
		await conn.close()
	})
})
