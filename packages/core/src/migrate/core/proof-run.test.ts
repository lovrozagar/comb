import { afterEach, describe, expect, it } from "vitest"
import { libsqlConnection, type LibsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { type Proof, provePending } from "./proof-run.ts"

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
		"M5: UNIQUE ON CONFLICT IGNORE",
		rebuild("id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT UNIQUE ON CONFLICT IGNORE"),
		"loses",
	],
	[
		"M5: NOT NULL ON CONFLICT IGNORE",
		rebuild("id INTEGER PRIMARY KEY, email TEXT NOT NULL ON CONFLICT IGNORE, code TEXT, tier TEXT"),
		"loses",
	],
]

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

	it("proves Atlas's plain rebuild clean, and a new column's backfill too", async () => {
		const clean = await prove(
			USERS,
			rebuild(
				"id INTEGER PRIMARY KEY, email TEXT, code TEXT, tier TEXT NOT NULL DEFAULT ''",
				"id, email, code, IFNULL(tier, '') AS tier",
			),
		)
		expect(clean).toEqual({ cautious: ["fills users.tier's NULLs with its default"], unproven: [], unsafe: [] })
		expect(await prove(USERS, "ALTER TABLE users ADD COLUMN plan TEXT;\nUPDATE users SET plan = 'free';")).toEqual({
			cautious: [],
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
	it("lists a table whose rows it cannot make as unproven, and proves nothing of it", async () => {
		const proof = await prove(
			"CREATE TABLE codes (id INTEGER PRIMARY KEY, code TEXT NOT NULL CHECK (length(code) = 11));",
			"DELETE FROM codes;",
		)
		expect(proof.unproven).toEqual(["codes"])
		expect(proof.unsafe).toEqual([])
	})

	it("says a file that does not apply to the copy proves nothing, nor does any after it", async () => {
		const conn = libsqlConnection()
		open.push(conn)
		await conn.client.executeMultiple(USERS)
		const proofs = await provePending(conn, [
			{ name: "2_bad.sql", sql: "ALTER TABLE missing ADD COLUMN x TEXT;" },
			{ name: "3_after.sql", sql: "DELETE FROM users;" },
		])
		expect(proofs.get("2_bad.sql")?.failed).toMatch(/^it did not apply to the copy: .*missing/)
		expect(proofs.get("3_after.sql")?.failed).toBe("an earlier pending file, 2_bad.sql, did not apply to the copy")
	})

	it("seeds a parent before its child, an enum column from its listed values, and leaves D1's own tables out", async () => {
		const proof = await prove(
			"CREATE TABLE _cf_KV (k TEXT);\nCREATE TABLE child (id TEXT PRIMARY KEY, parent TEXT NOT NULL REFERENCES parent(id), kind TEXT NOT NULL CHECK (kind IN ('a', 'b')));\nCREATE TABLE parent (id TEXT PRIMARY KEY);",
			"UPDATE child SET kind = 'a';",
		)
		expect(proof.unproven).toEqual([])
		expect(proof.unsafe).toEqual(["changes values of child.kind"])
	})
})

/** A target whose sqlite_master holds exactly `objects`, read through a connection that answers only that */
const target = (objects: Array<[type: string, name: string, sql: string]>) => ({
	batch: async () => undefined,
	close: async () => undefined,
	dialect: "sqlite" as const,
	execute: async () => ({ columns: ["type", "name", "sql"], rows: objects }),
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
		expect(unproven).toEqual(expect.arrayContaining(["odd", "box"]))
	})

	it("calls a dropped column lost", async () => {
		expect((await prove(USERS, "ALTER TABLE users DROP COLUMN code;")).unsafe).toEqual(["loses users.code"])
	})
})

describe("provePending with the database's own triggers and views", () => {
	it("runs a live trigger as the target would: an insert that fires one emptying a table loses its rows", async () => {
		const proof = await prove(
			`${USERS}\nCREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT);\nCREATE TRIGGER purge AFTER INSERT ON users BEGIN DELETE FROM audit; END;\nCREATE VIEW emails AS SELECT email FROM users;`,
			"INSERT INTO users (email) VALUES ('new');",
		)
		expect(proof.unsafe).toEqual([
			"loses 6 of audit's 6 rows",
			"changes values of audit.id",
			"changes values of audit.note",
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
		expect((await prove(T, both)).unsafe).toEqual(["changes rows of t"])
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
