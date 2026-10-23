import { afterEach, describe, expect, it } from "vitest"
import { libsqlConnection, type LibsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { classifyMigration } from "./classify.ts"
import { type Proof, provePending } from "./proof-run.ts"
import { extractSchema } from "./schema.ts"

const open: LibsqlConnection[] = []
afterEach(async () => {
	for (const conn of open.splice(0)) await conn.close()
})

/** The proof of `file` on a database the live schema `live` made, the classifier out of the way entirely */
async function prove(live: string, file: string): Promise<Proof> {
	const conn = libsqlConnection()
	open.push(conn)
	await conn.client.executeMultiple(live)
	const proofs = await provePending(conn, [{ name: "2_file.sql", sql: file }])
	return proofs.get("2_file.sql") as Proof
}

const USERS = "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT);"
/** Atlas's rebuild of users into `columns`, copying `copy` */
const rebuild = (columns: string, copy = "id, email, code, tier") =>
	`CREATE TABLE new_users (${columns});\nINSERT INTO new_users (id, email, code, tier) SELECT ${copy} FROM users;\nDROP TABLE users;\nALTER TABLE new_users RENAME TO users;`

/** Each 0.9.1 review bypass (M1–M5) as a file, and what its proof says */
const REVIEW_BYPASSES: Array<[string, string, string]> = [
	[
		"M1: a trigger that deletes on every insert",
		"CREATE TRIGGER wipe AFTER INSERT ON users BEGIN DELETE FROM users; END;\nINSERT INTO users (email) VALUES ('x');",
		"loses",
	],
	[
		"M1: a trigger that nulls every email",
		"CREATE TRIGGER nul AFTER INSERT ON users BEGIN UPDATE users SET email = NULL; END;\nINSERT INTO users (email) VALUES ('x');",
		"changes values of users.email",
	],
	[
		"M3: an UPDATE after CREATE TABLE IF NOT EXISTS of the table",
		`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT);\nUPDATE users SET email = NULL;`,
		"changes values of users.email",
	],
	[
		"M4: a write to the rebuild's copy before the rename",
		rebuild("id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT").replace(
			"DROP TABLE users;",
			"UPDATE new_users SET email = NULL;\nDROP TABLE users;",
		),
		"changes values of users.email",
	],
	[
		"M5: a retype to INTEGER affinity",
		rebuild("id INTEGER PRIMARY KEY, email TEXT, code INTEGER, tier TEXT"),
		"changes values of users.code",
	],
	[
		"M5: NOT NULL ON CONFLICT IGNORE",
		rebuild("id INTEGER PRIMARY KEY, email TEXT NOT NULL ON CONFLICT IGNORE, code TEXT, tier TEXT"),
		"loses",
	],
]

/* the seed repeats no value now (plan 12, M7), so a new UNIQUE … ON CONFLICT IGNORE drops no seeded row: the classifier rates it */
describe("a rebuild to UNIQUE ON CONFLICT IGNORE (0.9.1's M5)", () => {
	it("is unsafe by the classifier, whatever the proof sees", () => {
		const file = rebuild("id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT UNIQUE ON CONFLICT IGNORE")
		const before = extractSchema(USERS)
		expect(classifyMigration(file, { before, dialect: "sqlite" }).safety).toBe("unsafe")
	})
})

describe("provePending catches each 0.9.1 review bypass on its own (M1–M5, M8)", () => {
	it.each(REVIEW_BYPASSES)("%s", async (_, file, found) => {
		const proof = await prove(USERS, file)
		expect(proof.unsafe.join("\n")).toContain(found)
	})

	it("M5: NOT NULL ON CONFLICT REPLACE fills NULLs with the new default, the allowance; the classifier rates the clause unsafe", async () => {
		const proof = await prove(
			USERS,
			rebuild("id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT NOT NULL ON CONFLICT REPLACE DEFAULT 'gone'"),
		)
		expect(proof).toEqual({ cautious: ["fills users.tier's NULLs with its default"], unproven: [], unsafe: [] })
	})

	it("M8: a stored-content FTS5 table recreated as an index of an empty table loses its text", async () => {
		const proof = await prove(
			"CREATE TABLE src (id INTEGER PRIMARY KEY, body TEXT);\nCREATE VIRTUAL TABLE notes USING fts5(body);",
			"DROP TABLE notes;\nCREATE VIRTUAL TABLE notes USING fts5(body, content='src', content_rowid='id');\nINSERT INTO notes(notes) VALUES ('rebuild');",
		)
		expect(proof.unsafe).toContain("loses every row of notes")
	})
})

/** comb 0.8's bypasses (G1–G3) as files, and what their proof says */
const OLD_BYPASSES: Array<[string, string, string]> = [
	[
		"G1: a filtered copy",
		rebuild("id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT").replace(
			"FROM users;",
			"FROM users WHERE id > 1;",
		),
		"loses",
	],
	[
		"G2: a NULL copied for a column",
		rebuild("id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT", "id, NULL, code, tier"),
		"changes values of users.email",
	],
	["G3: a tautological DELETE", "DELETE FROM users WHERE 1 = 1 OR id IS NULL;", "loses"],
]

describe("provePending on comb 0.8's bypasses, and on a rebuild that loses nothing", () => {
	it.each(OLD_BYPASSES)("%s", async (_, file, found) => {
		expect((await prove(USERS, file)).unsafe.join("\n")).toContain(found)
	})

	it("reports a loss of rows once, not as a change to every column's values", async () => {
		const proof = await prove(
			USERS,
			rebuild("id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT").replace(
				"FROM users;",
				"FROM users WHERE id > 1;",
			),
		)
		expect(proof.unsafe).toEqual([expect.stringMatching(/^loses \d of the 8 rows of users$/)])
	})

	it("proves Atlas's plain rebuild clean, and calls a new column's backfill cautious", async () => {
		const clean = await prove(
			USERS,
			rebuild(
				"id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT NOT NULL DEFAULT ''",
				"id, email, code, IFNULL(tier, '') AS tier",
			),
		)
		expect(clean).toEqual({ cautious: ["fills users.tier's NULLs with its default"], unproven: [], unsafe: [] })
		expect(await prove(USERS, "ALTER TABLE users ADD COLUMN plan TEXT;\nUPDATE users SET plan = 'free';")).toEqual({
			cautious: ["UPDATE users SET plan = 'free': backfills users (plan), columns this file added"],
			unproven: [],
			unsafe: [],
		})
	})

	it("calls a rebuild that maps every row to the default unsafe: only NULLs may become it", async () => {
		const proof = await prove(
			USERS,
			rebuild("id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT NOT NULL DEFAULT ''", "id, email, code, ''"),
		)
		expect(proof.unsafe).toContain("changes values of users.tier")
	})

	it("allows the default only in a column the file made NOT NULL, and as the exact default", async () => {
		const still = await prove(
			USERS,
			rebuild(
				"id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT DEFAULT ''",
				"id, email, code, IFNULL(tier, '')",
			),
		)
		expect(still.unsafe).toContain("changes values of users.tier")
		const other = await prove(
			USERS,
			rebuild(
				"id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT NOT NULL DEFAULT ''",
				"id, email, code, IFNULL(tier, 'x')",
			),
		)
		expect(other.unsafe).toContain("changes values of users.tier")
	})
})

describe("provePending on what it cannot seed or apply", () => {
	it("lists a table whose rows it cannot make as unproven, and still sees a delete of its rows", async () => {
		const proof = await prove(
			"CREATE TABLE codes (id INTEGER PRIMARY KEY, code TEXT NOT NULL CHECK (length(code) = 20));",
			"DELETE FROM codes;",
		)
		expect(proof.unproven).toEqual([{ table: "codes", why: "CHECK constraint failed: length(code) = 20" }])
		expect(proof.unsafe).toEqual(["DELETE FROM codes: deletes existing rows of codes"])
	})

	it("says a file that does not apply to the copy proves nothing, nor does any after it", async () => {
		const conn = libsqlConnection()
		open.push(conn)
		await conn.client.executeMultiple(USERS)
		const proofs = await provePending(conn, [
			{ name: "2_bad.sql", sql: "ALTER TABLE missing ADD COLUMN x TEXT;" },
			{ name: "3_after.sql", sql: "DELETE FROM users;" },
		])
		expect(proofs.get("2_bad.sql")?.failed).toMatch(/^comb could not run this in the proof copy: .*missing/)
		expect(proofs.get("3_after.sql")?.failed).toBe(
			"an earlier pending file, 2_bad.sql, could not run in the proof copy, so this one is unproven",
		)
	})

	it("seeds a parent before its child, an enum column from its listed values, and leaves D1's own tables out", async () => {
		const proof = await prove(
			"CREATE TABLE _cf_KV (k TEXT);\nCREATE TABLE child (id TEXT PRIMARY KEY, parent TEXT NOT NULL REFERENCES parent(id), kind TEXT NOT NULL CHECK (kind IN ('a', 'b')));\nCREATE TABLE parent (id TEXT PRIMARY KEY);",
			"UPDATE child SET kind = 'a';",
		)
		expect(proof.unproven).toEqual([])
		expect(proof.unsafe).toEqual([
			"UPDATE child SET kind = 'a': updates existing rows of child (kind)",
			"changes values of child.kind",
		])
	})
})

/** A target whose sqlite_master holds exactly `objects`, read through a connection that answers only that */
/** A target whose schema is `objects`, each on the table it names last, as sqlite_master's tbl_name has it */
const target = (objects: Array<[type: string, name: string, sql: string, table?: string]>) => ({
	batch: async () => undefined,
	close: async () => undefined,
	dialect: "sqlite" as const,
	execute: async () => ({
		columns: ["type", "name", "sql", "tbl_name"],
		rows: objects.map(([type, name, sql, table = name]) => [type, name, sql, table]),
	}),
})

describe("provePending on what the copy cannot make, and on a lost column", () => {
	it("lists a table the copy cannot create, and a virtual table it does not seed, as unproven", async () => {
		const proofs = await provePending(
			target([
				["table", "odd", "CREATE VIRTUAL TABLE odd USING no_such_module(a)"],
				["table", "box", "CREATE VIRTUAL TABLE box USING rtree(id, x0, x1)"],
			]),
			[{ name: "1.sql", sql: "SELECT 1;" }],
		)
		const unproven = proofs.get("1.sql")?.unproven ?? []
		expect(unproven.map(({ table }) => table)).toEqual(expect.arrayContaining(["odd", "box"]))
	})

	it("lists a trigger the copy cannot create as its table, unproven, and a view it cannot as nothing (M20)", async () => {
		const proofs = await provePending(
			target([
				["table", "t", "CREATE TABLE t (a TEXT)"],
				["trigger", "tr", "CREATE TRIGGER tr INSTEAD OF INSERT ON t BEGIN SELECT 1; END", "t"],
				["view", "v", "CREATE VIEW v AS SELECT a FROM t GROUP", "v"],
			]),
			[{ name: "1.sql", sql: "SELECT 1;" }],
		)
		expect(proofs.get("1.sql")?.unproven).toEqual([
			{ table: "t", why: "its trigger tr could not be created: cannot create INSTEAD OF trigger on table: t" },
		])
	})

	it("calls a dropped column lost", async () => {
		expect((await prove(USERS, "ALTER TABLE users DROP COLUMN code;")).unsafe).toEqual(["loses users.code"])
	})
})

describe("provePending with the database's own triggers and views", () => {
	/* M12 of the 0.12 round: a temp table of the same name answers for a bare name, so the rows compared are main's */
	it("compares main's rows, though a temp table takes the table's name", async () => {
		const proof = await prove(USERS, "CREATE TEMP TABLE users AS SELECT * FROM main.users;\nDELETE FROM main.users;")
		expect(proof.unsafe).toContain("loses 8 of the 8 rows of users")
	})

	it("runs a live trigger as the target would: an insert that fires one emptying a table loses its rows", async () => {
		const proof = await prove(
			`${USERS}\nCREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT);\nCREATE TRIGGER purge AFTER INSERT ON users BEGIN DELETE FROM audit; END;\nCREATE VIEW emails AS SELECT email FROM users;`,
			"INSERT INTO users (email) VALUES ('new');",
		)
		expect(proof.unsafe).toEqual([
			"INSERT INTO users (email) VALUES ('new'): deletes existing rows of audit",
			"INSERT INTO users (email) VALUES ('new'): fires trigger purge (its WHEN is not evaluated)",
			"loses 6 of the 6 rows of audit",
		])
	})
})

const T = "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT, n INTEGER NOT NULL DEFAULT 0);"

describe("provePending on values moved between columns or rows of one type (G1b)", () => {
	it.each([
		["a copy of one column into another of its type", "UPDATE t SET a = b;", "changes values of t.a"],
		["a swap of two columns of one type", "UPDATE t SET a = b, b = a;", "changes values of t.a"],
		[
			"a rotation of one column across rows, which keeps its values",
			"CREATE TEMP TABLE r AS SELECT id, a FROM t;\nUPDATE t SET a = (SELECT r.a FROM r WHERE r.id = COALESCE((SELECT min(id) FROM r WHERE id > t.id), (SELECT min(id) FROM r)));",
			"changes values of t.a",
		],
		["a rebuild whose copy feeds a from b", rebuildT("id, b, b, n"), "changes values of t.a"],
	])("catches %s", async (_, file, found) => {
		expect((await prove(T, file)).unsafe).toContain(found)
	})

	it("says the rows changed when two columns each moved across rows, which no one column explains", async () => {
		const both =
			"CREATE TEMP TABLE r AS SELECT id, a, b FROM t;\nUPDATE t SET a = (SELECT r.a FROM r WHERE r.id = COALESCE((SELECT min(id) FROM r WHERE id > t.id), (SELECT min(id) FROM r))), b = (SELECT r.b FROM r WHERE r.id = COALESCE((SELECT max(id) FROM r WHERE id < t.id), (SELECT max(id) FROM r)));"
		expect((await prove(T, both)).unsafe).toContain("changes rows of t")
	})

	it("still proves a no-op and Atlas's plain rebuild clean, and the NOT NULL default rebuild cautious", async () => {
		const clean = { cautious: [], unproven: [], unsafe: [] }
		expect(await prove(T, "SELECT 1;")).toEqual(clean)
		expect(await prove(T, rebuildT("id, a, b, n"))).toEqual(clean)
		const defaulted = rebuildT("id, IFNULL(a, ''), b, n").replace("a TEXT,", "a TEXT NOT NULL DEFAULT '',")
		expect(await prove(T, defaulted)).toEqual({
			cautious: ["fills t.a's NULLs with its default"],
			unproven: [],
			unsafe: [],
		})
	})
})

/** Atlas's rebuild of t, copying `copy` */
function rebuildT(copy: string): string {
	return `CREATE TABLE new_t (id INTEGER PRIMARY KEY, a TEXT, b TEXT, n INTEGER NOT NULL DEFAULT 0);\nINSERT INTO new_t (id, a, b, n) SELECT ${copy} FROM t;\nDROP TABLE t;\nALTER TABLE new_t RENAME TO t;`
}
