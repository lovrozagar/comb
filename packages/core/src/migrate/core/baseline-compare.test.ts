import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { refuseDrift, sqliteDrift } from "./baseline-compare.ts"
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
		const from = args[args.indexOf("--from") + 1] as string
		if (args[0] === "schema" && from.startsWith("file://")) live.push(readFileSync(from.replace("file://", ""), "utf8"))
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
		const drifted = atlas('-- Modify "a" table: synced\nALTER TABLE "a" ADD COLUMN "x" int;\n')
		expect(() => refuseDrift({ exec: drifted, target: target("synced") }, join(dir, "m"))).toThrow(
			'the difference:\n-- Modify "a" table: ***\nALTER TABLE "a" ADD COLUMN "x" int;',
		)
	})
})
