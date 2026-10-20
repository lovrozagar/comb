import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { sqliteDrift } from "./baseline-compare.ts"
import type { Run } from "./process.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-baseline-compare-"))
	mkdirSync(join(dir, "m"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** atlas: hash writes nothing; schema diff keeps the database's DDL it was handed and answers `stdout` */
function atlas(stdout: string, code = 0): Run & { live: string[] } {
	const live: string[] = []
	const run: Run = (_cmd, args) => {
		if (args[0] === "schema") {
			live.push(readFileSync((args[args.indexOf("--from") + 1] as string).replace("file://", ""), "utf8"))
		}
		if (args[0] !== "schema") return { code: 0, stderr: "", stdout: "" }
		return { code, stderr: code === 0 ? "" : "boom", stdout }
	}
	return Object.assign(run, { live })
}

describe("sqliteDrift", () => {
	it("hands Atlas the database without its FTS objects, shadow tables or history, and names an FTS group only one side has", async () => {
		writeFileSync(join(dir, "m", "1_init.sql"), "CREATE TABLE post (id TEXT, title TEXT);")
		const conn = libsqlConnection()
		await conn.client.executeMultiple(
			"CREATE TABLE post (id TEXT, title TEXT); CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY); CREATE VIRTUAL TABLE post_fts USING fts5(title, content='post'); CREATE TRIGGER post_fts_ai AFTER INSERT ON post BEGIN INSERT INTO post_fts(rowid, title) VALUES (new.rowid, new.title); END;",
		)
		const run = atlas("Schemas are synced, no changes to be made.\n")
		expect(await sqliteDrift(conn, join(dir, "m"), run)).toBe(
			"-- FTS table post_fts: only in the database\n-- FTS trigger post_fts_ai: only in the database",
		)
		expect(run.live).toEqual(["CREATE TABLE post (id TEXT, title TEXT);\n"])
		await expect(sqliteDrift(conn, join(dir, "m"), atlas("", 1))).rejects.toThrow("atlas schema diff failed: boom")
		await conn.close()
	})
})
