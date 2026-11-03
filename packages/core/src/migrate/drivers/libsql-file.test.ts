import { createClient } from "@libsql/client"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { bound, openLibsqlFile } from "./libsql-file.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

/** A new database file's path */
function dbFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-libsql-file-"))
	dirs.push(dir)
	return path.join(dir, "core.db")
}

/** This process's descriptors open on `file` or a file beside it of its name */
const openOn = (file: string) =>
	fs.readdirSync("/proc/self/fd").filter((fd) => {
		try {
			return fs.readlinkSync(path.join("/proc/self/fd", fd)).startsWith(file)
		} catch {
			// reason: the descriptor readdir held, closed since, links nowhere
			return false
		}
	}).length

/** The rows `sql` reads from `file`, through @libsql/client */
async function rows(file: string, sql: string): Promise<unknown[][]> {
	const client = createClient({ url: `file:${file}` })
	try {
		return (await client.execute(sql)).rows.map((row) => Array.from({ length: row.length }, (_, at) => row[at]))
	} finally {
		client.close()
	}
}

describe("openLibsqlFile (SL1 of r22)", () => {
	it("applies a batch in one transaction, its parameters as literals, and lets go of the file on close", async () => {
		const file = dbFile()
		for (let at = 0; at < 3; at++) {
			const conn = await openLibsqlFile(file)
			await conn.batch([
				{ sql: `CREATE TABLE t${at} (a TEXT, b INTEGER, c, d)` },
				{ params: ["it's", 7, 42n, null], sql: `INSERT INTO t${at} VALUES (?, ?, ?, ?)` },
			])
			await conn.close()
		}
		expect(openOn(file)).toBe(0)
		expect(await rows(file, "SELECT a, b, c, d FROM t2")).toEqual([["it's", 7, 42, null]])
	})
})

describe("openLibsqlFile on a failure (SL1 of r22)", () => {
	it("rolls a failing batch back whole and words its error as @libsql/client does", async () => {
		const file = dbFile()
		const conn = await openLibsqlFile(file)
		try {
			const failure = await conn
				.batch([{ sql: "CREATE TABLE a (x)" }, { sql: "INSERT INTO b VALUES (1)" }])
				.catch((error: unknown) => error)
			expect(failure).toMatchObject({ code: "SQLITE_ERROR", message: "SQLITE_ERROR: no such table: b" })
			await conn.batch([{ sql: "CREATE TABLE a (x)" }])
		} finally {
			await conn.close()
		}
		expect(await rows(file, "SELECT name FROM sqlite_master")).toEqual([["a"]])
	})

	it("passes on a trigger's RAISE(ROLLBACK), which ended the transaction itself, as SQLite words it", async () => {
		const file = dbFile()
		const conn = await openLibsqlFile(file)
		try {
			await conn.batch([
				{ sql: "CREATE TABLE a (x)" },
				{ sql: "CREATE TRIGGER a_no BEFORE INSERT ON a WHEN new.x < 0 BEGIN SELECT RAISE(ROLLBACK, 'negative'); END" },
			])
			await expect(
				conn.batch([{ sql: "INSERT INTO a VALUES (1)" }, { sql: "INSERT INTO a VALUES (-1)" }]),
			).rejects.toMatchObject({
				code: expect.stringMatching(/^SQLITE_CONSTRAINT/),
				message: expect.stringContaining("negative"),
			})
		} finally {
			await conn.close()
		}
		expect(await rows(file, "SELECT count(*) FROM a")).toEqual([[0]])
	})

	it("passes on a failure that is not libsql's as it came, the transaction rolled back", async () => {
		const file = dbFile()
		const conn = await openLibsqlFile(file)
		try {
			await expect(conn.batch([{ sql: "CREATE TABLE a (x)" }, { params: [{}], sql: "SELECT ?" }])).rejects.toThrow(
				"comb binds no object as a SQL literal",
			)
			await expect(conn.batch([{ params: [Number.NaN], sql: "SELECT ?" }])).rejects.toThrow("binds no number")
			await expect(conn.batch([{ params: [1, 2], sql: "SELECT ?" }])).rejects.toThrow(
				"2 parameters for 1 placeholders in SELECT ?",
			)
		} finally {
			await conn.close()
		}
		expect(await rows(file, "SELECT count(*) FROM sqlite_master")).toEqual([[0]])
	})

	it("passes on a database it cannot open as libsql reports it", async () => {
		await expect(openLibsqlFile(path.join(dbFile(), "missing", "core.db"))).rejects.toThrow(/Unable to open/)
	})
})

/* SL3n of r22: a number goes in as the class bun:sqlite's binding stores it (.tmp/grunt/p21/areas/sqlite/sl3n/big-probe.log) */
describe("bound: a number's literal keeps the class bun:sqlite binds it as", () => {
	it("writes a safe integer as INTEGER, and -0, a fraction and an integral number past 2^53 as REAL", () => {
		expect(bound("SELECT ?, ?, ?, ?, ?, ?, ?", [1, 0, -(2 ** 53 - 1), -0, 2 ** 53, 1.5, 1e21])).toBe(
			"SELECT 1, 0, -9007199254740991, -0.0, 9007199254740992.0, 1.5, 1e+21",
		)
		expect(bound("SELECT ?, ?", [90_071_992_547_409_920, 5e-324])).toBe("SELECT 90071992547409920.0, 5e-324")
		expect(bound("SELECT ?", [2n ** 62n])).toBe("SELECT 4611686018427387904")
	})
})
