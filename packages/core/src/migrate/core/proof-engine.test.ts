import { describe, expect, it } from "vitest"
import { FILE, type Read, START, stateOf } from "../__fixtures__/apply-parity.ts"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { openMemory } from "../drivers/memory.ts"
import { splitSqlStatements } from "./sql-scan.ts"
import { applyToCopy, engineFindings } from "./proof-engine.ts"
import { provePending } from "./proof-run.ts"

/** A libsql connection's reads, each row as its columns by name */
const readOf =
	(conn: ReturnType<typeof libsqlConnection>): Read =>
	async (sql) => {
		const { columns, rows } = await conn.execute(sql)
		return rows.map((row) => Object.fromEntries(columns.map((column, i) => [column, row[i]])))
	}

describe("the proof's engine pass leaves the copy as the target's own apply leaves the target", () => {
	it("ends in the same schema and rows on node:sqlite as a libsql target does", async () => {
		const target = libsqlConnection()
		await target.client.executeMultiple(START)
		await target.batch(splitSqlStatements(FILE).map((sql) => ({ sql })))
		const copy = await openMemory()
		copy.exec(START)
		expect(applyToCopy(copy, FILE).error).toBeUndefined()
		expect(await stateOf(async (sql) => copy.all(sql))).toEqual(await stateOf(readOf(target)))
		copy.close()
		await target.close()
	})

	it("leaves the target's schema and rows as they were: the proof only reads it", async () => {
		const target = libsqlConnection()
		await target.client.executeMultiple(START)
		const before = await stateOf(readOf(target))
		const proofs = await provePending(target, [{ name: "1_m.sql", sql: FILE }])
		expect(proofs.get("1_m.sql")?.failed).toBeUndefined()
		expect(await stateOf(readOf(target))).toEqual(before)
		await target.close()
	})
})

/* the tables the engine tests write: k with two indexes, a parent its child cascades from, and an
   FTS5 table; no rows, so only the engine can see a write */
const TABLES = `CREATE TABLE k (id INTEGER PRIMARY KEY, a TEXT NOT NULL, b TEXT UNIQUE);
CREATE INDEX k_a ON k (a);
CREATE TABLE parent (id INTEGER PRIMARY KEY);
CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent (id) ON DELETE CASCADE);
CREATE VIRTUAL TABLE notes USING fts5 (body);`

/** The unsafe notes the engine pass gives `sql` on a copy of TABLES that holds no row */
async function unsafeOf(sql: string): Promise<string[]> {
	const db = await openMemory()
	db.exec(TABLES)
	const run = applyToCopy(db, sql)
	db.close()
	expect(run.error).toBeUndefined()
	return engineFindings(run.steps, run.start).unsafe
}

/* the 0.13 review of 7f2667f: a delete SQLite codes without a Delete opcode is a delete all the same */
describe("the engine pass on a delete of every row", () => {
	it.each([
		[
			"a bare DELETE, which SQLite codes as a Clear of the table and its indexes",
			"DELETE FROM k;",
			"deletes existing rows of k",
		],
		[
			"a bare DELETE of a parent, which foreign keys code row by row",
			"DELETE FROM parent;",
			"deletes existing rows of parent",
		],
		["a bare DELETE of an FTS5 table", "DELETE FROM notes;", "writes over rows of a virtual table"],
		[
			"a bare DELETE in the trigger of a table the file creates",
			"CREATE TABLE fresh (x TEXT);\nCREATE TRIGGER f AFTER INSERT ON fresh BEGIN DELETE FROM k; END;\nINSERT INTO fresh VALUES ('x');",
			"deletes existing rows of k",
		],
	])("calls %s unsafe", async (_label, sql, note) => {
		expect((await unsafeOf(sql)).join("\n")).toContain(note)
	})

	it("names a cascade a parent's delete runs on its child", async () => {
		expect(await unsafeOf("DELETE FROM parent WHERE id = 1;")).toContain(
			"DELETE FROM parent WHERE id = 1: deletes existing rows of child",
		)
	})

	it("leaves an insert, a REINDEX, and a delete of a table the file created, to no note", async () => {
		expect(
			await unsafeOf("INSERT INTO k (a) VALUES ('x');\nREINDEX k;\nCREATE TABLE t (x TEXT);\nDELETE FROM t;"),
		).toEqual([])
	})
})
