import { describe, expect, it, vi } from "vitest"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import type { Connection } from "../types.ts"
import { notEngineTables } from "./engine-tables.ts"
import { copyScript, creatable, liveObjects } from "./proof-copy.ts"

/** The live schema of `conn`, as the proof reads it */
const schemaOf = async (conn: Connection) => creatable(await liveObjects(conn, notEngineTables(conn)))

vi.mock("bun:sqlite", () => import("../__fixtures__/bun-sqlite-node.ts"))

const LIVE = [
	"CREATE TABLE post (id INTEGER PRIMARY KEY, title TEXT NOT NULL, words INTEGER GENERATED ALWAYS AS (length(title)) VIRTUAL)",
	"CREATE INDEX post_title ON post (title)",
	"CREATE VIRTUAL TABLE post_fts USING fts5 (title)",
	"CREATE TABLE log (post INTEGER)",
	"CREATE TRIGGER post_log AFTER INSERT ON post BEGIN INSERT INTO log (post) VALUES (new.id); END",
	"CREATE VIEW titles AS SELECT title FROM post",
	"INSERT INTO post (title) VALUES ('live row')",
]

describe("copyScript (SD1 of r22): the proof's copy as statements another engine runs", () => {
	it("holds the live schema in the proof's order and its seeded rows, and runs back to the same copy", async () => {
		const live = libsqlConnection()
		const back = libsqlConnection()
		try {
			await live.client.executeMultiple(LIVE.map((sql) => `${sql};`).join("\n"))
			const script = await copyScript(await schemaOf(live), [
				{ sql: "UPDATE post SET title = json_extract(title, '$.a')" },
			])
			/* D1 holds every foreign key on: the batch opens deferring them, for a cycle of keys */
			expect(script[0]).toBe("PRAGMA defer_foreign_keys = ON")
			const kinds = script.slice(1).map((sql) => (/^(CREATE (?:VIRTUAL )?\w+|INSERT)/.exec(sql) as RegExpExecArray)[1])
			const first = (kind: string) => kinds.indexOf(kind)
			expect(first("CREATE TABLE")).toBe(0)
			expect(first("CREATE INDEX")).toBeLessThan(first("INSERT"))
			expect(first("INSERT")).toBeLessThan(first("CREATE TRIGGER"))
			expect(first("CREATE TRIGGER")).toBeLessThan(first("CREATE VIEW"))
			/* the live rows stay live: the copy holds the seed's, none into the virtual table or a generated column */
			const inserts = script.filter((sql) => sql.startsWith("INSERT"))
			expect(inserts.length).toBeGreaterThan(0)
			expect(inserts.some((sql) => sql.includes("live row") || sql.includes("post_fts") || sql.includes("words"))).toBe(
				false,
			)
			await back.batch(script.map((sql) => ({ sql })))
			const names = await back.execute(
				"SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'post_fts_%' ORDER BY name",
			)
			expect(names.rows).toEqual([
				["table", "log"],
				["table", "post"],
				["table", "post_fts"],
				["trigger", "post_log"],
				["index", "post_title"],
				["view", "titles"],
			])
			/* the trigger comes after the rows, so the seed of post fired none: log holds its own seed alone */
			const logged = inserts.filter((sql) => sql.startsWith('INSERT INTO "log"')).length
			expect((await back.execute("SELECT count(*) FROM log")).rows).toEqual([[logged]])
		} finally {
			await live.close()
			await back.close()
		}
	})

	it("leaves out an object the copy could not create", async () => {
		const live = libsqlConnection()
		try {
			await live.client.executeMultiple(
				"CREATE TABLE a (x);\nPRAGMA writable_schema = ON;\nINSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('table', 'broken', 'broken', 0, 'CREATE VIRTUAL TABLE broken USING no_such_module (x)');\nPRAGMA writable_schema = OFF;",
			)
			const script = await copyScript(await schemaOf(live), [{ sql: "UPDATE a SET x = 1;" }])
			expect(script[1]).toBe("CREATE TABLE a (x)")
			expect(script.slice(2).every((sql) => sql.startsWith('INSERT INTO "a" ("x") VALUES ('))).toBe(true)
			expect(script.some((sql) => sql.includes("broken"))).toBe(false)
		} finally {
			await live.close()
		}
	})
})

/** The tables copyScript seeds over a live database `schema` made, for pending `files` */
async function seededBy(schema: string, files: string[]): Promise<string[]> {
	const live = libsqlConnection()
	try {
		await live.client.executeMultiple(schema)
		const script = await copyScript(
			await schemaOf(live),
			files.map((sql) => ({ sql })),
		)
		const tables = script.flatMap((sql) => /^INSERT INTO "([^"]+)"/.exec(sql)?.[1] ?? [])
		return [...new Set(tables)].toSorted()
	} finally {
		await live.close()
	}
}

/* 8.5 of plan 21: the D1 proof seeds the tables pending files reach, not every table of a shard */
describe("copyScript seeds what the pending files reach (8.5)", () => {
	const UNRELATED = "CREATE TABLE unrelated (id INTEGER PRIMARY KEY, v TEXT);\n"

	it("seeds a child only its key reaches, whose rows block a pending DROP of its parent", async () => {
		const schema = `${UNRELATED}CREATE TABLE parent (id INTEGER PRIMARY KEY);\nCREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER NOT NULL REFERENCES parent (id));`
		expect(await seededBy(schema, ["DROP TABLE parent;"])).toEqual(["child", "parent"])
	})

	it("seeds a table reached only through a trigger on a table the file writes", async () => {
		const schema = `${UNRELATED}CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER);\nCREATE TABLE Log (n INTEGER);\nCREATE TRIGGER t_log AFTER UPDATE ON t BEGIN INSERT INTO "log" (n) VALUES (new.v); END;`
		expect(await seededBy(schema, ["UPDATE t SET v = 1;"])).toEqual(["Log", "t"])
	})

	it("seeds a table reached only through a view the file reads", async () => {
		const schema = `${UNRELATED}CREATE TABLE src (id INTEGER PRIMARY KEY, v INTEGER);\nCREATE VIEW [the view] AS SELECT v FROM src;`
		expect(await seededBy(schema, ['CREATE TABLE snap AS SELECT v FROM "The View";'])).toEqual(["src"])
	})

	it("seeds a grandchild, which a DROP of its grandparent reaches through a cascade", async () => {
		const schema = `${UNRELATED}CREATE TABLE parent (id INTEGER PRIMARY KEY);\nCREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER NOT NULL REFERENCES parent (id) ON DELETE CASCADE);\nCREATE TABLE grandchild (id INTEGER PRIMARY KEY, c INTEGER NOT NULL REFERENCES child (id));`
		expect(await seededBy(schema, ["DROP TABLE parent;"])).toEqual(["child", "grandchild", "parent"])
	})

	it("seeds each ancestor whose keys a reached table's rows take, but not an ancestor's other children", async () => {
		const schema = `${UNRELATED}CREATE TABLE org (id INTEGER PRIMARY KEY);\nCREATE TABLE team (id INTEGER PRIMARY KEY, org INTEGER NOT NULL REFERENCES org (id));\nCREATE TABLE member (id INTEGER PRIMARY KEY, team INTEGER NOT NULL REFERENCES team (id));\nCREATE TABLE invoice (id INTEGER PRIMARY KEY, org INTEGER NOT NULL REFERENCES org (id));`
		expect(await seededBy(schema, ["UPDATE member SET team = team;"])).toEqual(["member", "org", "team"])
	})

	it("seeds no table a pending file does not reach", async () => {
		expect(
			await seededBy(`${UNRELATED}CREATE TABLE other (id INTEGER PRIMARY KEY);`, ["CREATE TABLE probe (id);"]),
		).toEqual([])
	})
})
