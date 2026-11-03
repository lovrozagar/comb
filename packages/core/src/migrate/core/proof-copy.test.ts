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
			const kinds = script.map((sql) => (/^(CREATE (?:VIRTUAL )?\w+|INSERT)/.exec(sql) as RegExpExecArray)[1])
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
			const script = await copyScript(await schemaOf(live), [])
			expect(script[0]).toBe("CREATE TABLE a (x)")
			expect(script.slice(1).every((sql) => sql.startsWith('INSERT INTO "a" ("x") VALUES ('))).toBe(true)
			expect(script.some((sql) => sql.includes("broken"))).toBe(false)
		} finally {
			await live.close()
		}
	})
})
