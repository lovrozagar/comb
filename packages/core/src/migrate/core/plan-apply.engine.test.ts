import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import type { ParsedMigration } from "../types.ts"
import { planApply } from "./plan-apply.ts"
import { guardRebuilds } from "./rebuild-guard.ts"
import { extractSchema } from "./schema.ts"

/*
 * SQLite ratings come from the engine (plan 13): each statement of a pending file runs on the proof's
 * in-memory copy after EXPLAIN shows what it writes, the columns it assigns, the triggers it fires and
 * the temp objects that take a table's name. The 0.12 round's write shapes (M1–M3, M7), temp shadows
 * (M6, M12), laundered rebuild (M5) and silently skipped statement (M9) rate unsafe however they are
 * spelled, and with a predicate no seeded row meets, which the row compare alone cannot see; the
 * controls keep their ratings.
 */

/* the target: users with the history's trigger, which deletes a user's sessions on any update of
   them; accounts and k, tables no trigger watches, so a write to them is seen by its shape alone */
const TARGET = `CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, plan TEXT);
CREATE INDEX users_email ON users (email);
CREATE TABLE sessions (id INTEGER PRIMARY KEY, uid INTEGER);
CREATE TRIGGER logout AFTER UPDATE ON users WHEN NEW.id BETWEEN 1 AND 1000000000 BEGIN DELETE FROM sessions WHERE uid = NEW.id; END;
CREATE TABLE k (id INTEGER PRIMARY KEY, a TEXT NOT NULL, b TEXT);
CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT, plan TEXT);
CREATE INDEX accounts_email ON accounts (email);
CREATE TABLE audit (x TEXT);
CREATE TRIGGER wipe AFTER INSERT ON audit BEGIN DELETE FROM sessions; END;
CREATE TABLE post (id INTEGER PRIMARY KEY, title TEXT, n INTEGER);
CREATE VIRTUAL TABLE post_fts USING fts5(title, content='post', content_rowid='id');
CREATE TRIGGER post_fts_ai AFTER INSERT ON post BEGIN INSERT INTO post_fts(rowid, title) VALUES (new.id, new.title); END;
CREATE TRIGGER counted AFTER UPDATE OF n ON post BEGIN INSERT INTO audit (x) VALUES ('n'); END;
CREATE VIRTUAL TABLE notes USING fts5(body);`

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-engine-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** The rating `sql` gets as the one pending file against `target`, with the reasons it names */
async function rate(sql: string, target = TARGET): Promise<{ notes: string[]; safety: string }> {
	/* the history that made the target, applied: what a rebuild's earlier columns are read from */
	writeFileSync(join(dir, "0_init.sql"), target)
	writeFileSync(join(dir, "1_m.sql"), sql)
	const conn = libsqlConnection()
	await conn.client.executeMultiple(target)
	const seen: ParsedMigration[] = []
	await planApply({
		applied: (name) => name === "0_init.sql",
		approve: (migration) => {
			seen.push(migration)
			return Promise.resolve({ ok: true })
		},
		conn,
		dir,
		exec: () => ({ code: 0, stderr: "", stdout: "" }),
		files: ["0_init.sql", "1_m.sql"],
		print: () => undefined,
		whole: false,
	})
	const { classification } = seen[0] as ParsedMigration
	return {
		notes: [...classification.unsafeStatements, ...classification.cautiousStatements],
		safety: classification.safety,
	}
}

describe("engine ratings: the 0.12 round's shapes rate unsafe", () => {
	it.each([
		["M1, no space before SET", `UPDATE "accounts"SET email = NULL WHERE email = 'no-seed-holds-this';`],
		["M1, NOT INDEXED", `UPDATE accounts NOT INDEXED SET email = NULL WHERE email = 'no-seed-holds-this';`],
		[
			"M1, INDEXED BY",
			`UPDATE accounts INDEXED BY accounts_email SET email = NULL WHERE email = 'no-seed-holds-this';`,
		],
		[
			"M2, an upsert into a quoted name",
			`INSERT INTO"accounts"(id, email) VALUES (1,'x'),(2,'x') ON CONFLICT (id) DO UPDATE SET email = excluded.email;`,
		],
		[
			"M3, a second assignment after IS DISTINCT FROM",
			`ALTER TABLE accounts ADD COLUMN flag INTEGER;\nUPDATE accounts SET flag = email IS DISTINCT FROM NULL, email = NULL WHERE email = 'no-seed-holds-this';`,
		],
		[
			"M5, a clean rebuild after a lossy one",
			`CREATE TABLE new_users (id INTEGER PRIMARY KEY, email TEXT, plan TEXT);\nINSERT INTO new_users (id, email, plan) SELECT id, email, plan FROM users WHERE email IS NOT 'no-seed-holds-this';\nDROP TABLE users;\nALTER TABLE new_users RENAME TO users;\nCREATE TABLE new_users (id INTEGER PRIMARY KEY, email TEXT, plan TEXT);\nINSERT INTO new_users (id, email, plan) SELECT id, email, plan FROM users;\nDROP TABLE users;\nALTER TABLE new_users RENAME TO users;`,
		],
		[
			"M7, a CTE in front of a write the history's trigger watches",
			`ALTER TABLE users ADD COLUMN tier TEXT;\nWITH c AS (SELECT 1) UPDATE users SET tier = 'free';`,
		],
		["M9, a statement that fails on the copy before a later one", `UPDATE "k"SET a = b;\nCREATE INDEX k_b ON k (b);`],
		[
			"M12, a temp table then a write to the real one",
			`CREATE TABLE temp.accounts AS SELECT * FROM main.accounts;\nUPDATE main."accounts"SET email = NULL WHERE email = 'no-seed-holds-this';`,
		],
		["a REPLACE over existing rows", `INSERT OR REPLACE INTO users (id, email) VALUES (1, 'x');`],
	])("%s", async (_label, sql) => {
		expect((await rate(sql)).safety).toBe("unsafe")
	})

	it.each([
		["a temp.-qualified table", `CREATE TABLE temp.accounts AS SELECT * FROM main.accounts WHERE id > 1000;`],
		["a temp view", `CREATE TEMP VIEW accounts AS SELECT * FROM main.accounts WHERE id > 1000;`],
	])("M6, names %s that takes a table's name", async (_label, sql) => {
		const { notes, safety } = await rate(sql)
		expect(safety).toBe("unsafe")
		expect(notes.join("\n")).toContain("shadows accounts")
	})
})

describe("engine ratings: triggers, virtual tables and a file the copy refuses", () => {
	it("names a trigger it counts as fired, and that its WHEN is not evaluated", async () => {
		const { notes } = await rate(`ALTER TABLE users ADD COLUMN tier TEXT;\nUPDATE users SET tier = 'free';`)
		expect(notes.join("\n")).toContain("fires trigger logout (its WHEN is not evaluated)")
	})

	/* M4 of the 0.10 review: a write a trigger the history left observes, whatever its WHEN */
	it("names the trigger an insert fires", async () => {
		const { notes, safety } = await rate("INSERT INTO audit (x) VALUES ('y');")
		expect(safety).toBe("unsafe")
		expect(notes.join("\n")).toContain("fires trigger wipe (its WHEN is not evaluated)")
	})

	it("names a trigger another trigger fires, and none an UPDATE OF list leaves out", async () => {
		const { notes, safety } = await rate("UPDATE post SET n = 1 WHERE id = 1;")
		expect(safety).toBe("unsafe")
		expect(notes.join("\n")).toContain("fires trigger counted (its WHEN is not evaluated)")
		expect(notes.join("\n")).toContain("fires trigger wipe (its WHEN is not evaluated)")
		expect((await rate("ALTER TABLE post ADD COLUMN m INTEGER;\nUPDATE post SET m = 1;")).safety).toBe("cautious")
	})

	it.each([
		["an update", "UPDATE notes SET body = 'y';"],
		["a delete", "DELETE FROM notes WHERE rowid = 99;"],
		["a replace", "INSERT OR REPLACE INTO notes (rowid, body) VALUES (1, 'x');"],
	])("calls %s of a virtual table's rows unsafe", async (_label, sql) => {
		const { notes, safety } = await rate(sql)
		expect(safety).toBe("unsafe")
		expect(notes.join("\n")).toContain("writes over rows of a virtual table")
	})

	it("says why a file the copy cannot run is unproven, and so unsafe", async () => {
		const { notes } = await rate(`UPDATE "k"SET a = b;\nCREATE INDEX k_b ON k (b);`)
		expect(notes.join("\n")).toMatch(/comb could not run this in the proof copy: .*NOT NULL/)
	})
})

describe("engine ratings: the controls keep theirs", () => {
	it.each([
		[
			"a new table, index and view",
			`CREATE TABLE t_new (x TEXT);\nCREATE INDEX t_new_x ON t_new (x);\nCREATE VIEW v_new AS SELECT 1;`,
			"safe",
		],
		["a nullable ADD COLUMN", `ALTER TABLE k ADD COLUMN nick TEXT;`, "safe"],
		["an insert-only write", `INSERT INTO k (a) VALUES ('n');`, "safe"],
		[
			"an insert that does nothing on a conflict",
			`INSERT INTO k (id, a) VALUES (1, 'x') ON CONFLICT DO NOTHING;`,
			"safe",
		],
		[
			"a trigger-free backfill of the file's own column",
			`ALTER TABLE k ADD COLUMN c TEXT;\nUPDATE k SET c = a;`,
			"cautious",
		],
		[
			"Atlas's plain rebuild",
			`PRAGMA foreign_keys = off;\nCREATE TABLE new_k (id INTEGER PRIMARY KEY, a TEXT NOT NULL, b TEXT, c TEXT);\nINSERT INTO new_k (id, a, b) SELECT id, a, b FROM k;\nDROP TABLE k;\nALTER TABLE new_k RENAME TO k;\nPRAGMA foreign_keys = on;`,
			"cautious",
		],
		["an insert whose FTS sync trigger writes the index", `INSERT INTO post (title) VALUES ('t');`, "safe"],
		["an insert into a virtual table", `INSERT INTO notes (body) VALUES ('x');`, "safe"],
		["comb's rebuild of an FTS index", `INSERT INTO post_fts(post_fts) VALUES ('rebuild');`, "safe"],
	])("%s", async (_label, sql, safety) => {
		expect((await rate(sql)).safety).toBe(safety)
	})
})

/* a parent, a child that cascades from it and a grandchild: Atlas's rebuild of the parent needs comb's guard */
const FAMILY = `CREATE TABLE \`u\` (\`id\` integer PRIMARY KEY, \`name\` text);
CREATE TABLE \`post\` (\`id\` integer PRIMARY KEY, \`author\` integer REFERENCES \`u\`(\`id\`) ON DELETE CASCADE, \`title\` text);
CREATE TABLE \`tag\` (\`post\` integer NOT NULL REFERENCES \`post\`(\`id\`), \`name\` text NOT NULL, PRIMARY KEY (\`post\`, \`name\`)) WITHOUT ROWID;`
const REBUILD = `PRAGMA defer_foreign_keys = on;
CREATE TABLE \`new_u\` (\`id\` integer NOT NULL, \`name\` text NOT NULL DEFAULT '', PRIMARY KEY (\`id\`));
INSERT INTO \`new_u\` (\`id\`, \`name\`) SELECT \`id\`, IFNULL(\`name\`, '') AS \`name\` FROM \`u\`;
DROP TABLE \`u\`;
ALTER TABLE \`new_u\` RENAME TO \`u\`;
`

describe("engine ratings: comb's guarded rebuild", () => {
	it("keeps comb's guard cautious, and the same guard edited unsafe", async () => {
		const guarded = guardRebuilds(REBUILD, extractSchema(FAMILY))
		expect(await rate(guarded, FAMILY)).toMatchObject({ safety: "cautious" })
		const edited = guarded.replace("DELETE FROM `tag`;", "DELETE FROM `tag` WHERE 1;")
		expect((await rate(edited, FAMILY)).safety).toBe("unsafe")
	})
})

/* the SQLite verdicts the text classifier gave (classify-write.test.ts), now the engine's: what a
   write does to rows that were there before the file decides, not how it is spelled */
describe("engine ratings: SQLite writes", () => {
	it.each([
		"DELETE FROM accounts WHERE email IS NULL OR email IS NOT NULL;",
		"DELETE FROM accounts WHERE 1 < 2;",
		"DELETE FROM accounts WHERE NULL IS NULL;",
		"DELETE FROM accounts WHERE 1 = 1.0;",
		"DELETE FROM accounts WHERE id = 1;",
		"UPDATE accounts SET plan = 'pro' WHERE id = 1;",
		"INSERT INTO accounts (id, plan) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET plan = excluded.plan;",
		"UPDATE OR REPLACE accounts SET email = 'a' WHERE id = 1;",
		"REPLACE INTO accounts (id, plan) VALUES (1, 'x');",
		"INSERT OR REPLACE INTO accounts (id, plan) VALUES (1, 'x');",
		"CREATE TABLE IF NOT EXISTS accounts (id integer PRIMARY KEY, email text);\nUPDATE accounts SET email = NULL;",
		"CREATE TABLE Accounts (id integer PRIMARY KEY, email text);\nUPDATE accounts SET email = NULL;",
	])("calls %j unsafe", async (sql) => {
		expect((await rate(sql)).safety).toBe("unsafe")
	})

	const added = 'ALTER TABLE accounts ADD COLUMN tier text;\nALTER TABLE "accounts" ADD COLUMN "since" integer;\n'

	it("calls a backfill of the file's own columns cautious, a second one too, and one that also writes an older column unsafe", async () => {
		expect((await rate(`${added}UPDATE accounts SET tier = 'free', "since" = 0 WHERE tier IS NULL;`)).safety).toBe(
			"cautious",
		)
		/* nothing a second write to a column this file added overwrites was there before the file */
		expect(
			(await rate(`${added}UPDATE accounts SET tier = 'free';\nUPDATE accounts SET tier = 'pro' WHERE id = 1;`)).safety,
		).toBe("cautious")
		expect((await rate(`${added}UPDATE accounts SET tier = 'free', email = NULL;`)).safety).toBe("unsafe")
	})

	it("calls a write to a table or column the file has not made yet unsafe, as the copy cannot run it", async () => {
		expect((await rate(`${added}UPDATE other SET tier = 'free';`)).safety).toBe("unsafe")
		expect((await rate(`UPDATE accounts SET tier = 'free';\n${added}`)).safety).toBe("unsafe")
	})

	it("calls any write to a table this file created safe: no row in it was there before the file", async () => {
		const created = "CREATE TABLE `fresh` (`id` integer PRIMARY KEY, `a` text);\nINSERT INTO fresh VALUES (1, 'x');\n"
		expect((await rate(`${created}UPDATE fresh SET a = 'y' WHERE id = 1;`)).safety).toBe("safe")
		expect(
			(await rate(`${created}INSERT INTO fresh VALUES (1, 'z') ON CONFLICT (id) DO UPDATE SET a = excluded.a;`)).safety,
		).toBe("safe")
		expect((await rate(`${created}DELETE FROM fresh WHERE id = 1;`)).safety).toBe("safe")
	})
})
