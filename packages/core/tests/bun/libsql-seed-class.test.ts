/// <reference types="bun-types" />
/**
 * SL3n of r22: the libsql proof writes its seed as SQL literals (libsql's binding panics on a blob), so each
 * literal must store the class bun:sqlite's binding stores: a safe integer as INTEGER, any other number, -0
 * and an integral one past 2^53 among them, as REAL. Under BLOB or STRICT ANY affinity the class is kept as
 * written, so a REAL written `-0` or `90071992547409920` (a CHECK's listed values) turns INTEGER on the libsql
 * proof alone.
 */
import { describe, expect, it } from "bun:test"
import { copyOf, type LiveObject } from "../../src/migrate/core/proof-copy.ts"
import type { LocalDb } from "../../src/migrate/drivers/local-db.ts"

const TABLES: LiveObject[] = [
	"CREATE TABLE loose (id INTEGER PRIMARY KEY, b BLOB, n NUMERIC, r REAL, i INTEGER, t TEXT, x, d DECIMAL(10, 2), l CHECK (l IN (-0.0, 90071992547409920, 2.5)))",
	"CREATE TABLE strict (id INTEGER PRIMARY KEY, a ANY, r REAL, i INTEGER, t TEXT, b BLOB, l ANY CHECK (l IN (-0.0, 90071992547409920))) STRICT",
].map((sql) => {
	const name = (/^CREATE TABLE (\w+)/.exec(sql) as RegExpExecArray)[1] as string
	return { name, sql, table: name, type: "table" }
})

/**
 * Each table's rows, every column as its typeof() and its value, in key order: the value as read, a blob as hex,
 * since quote() prints a REAL differently on libsql's SQLite 3.45 and Bun's, and each driver reads a blob its way
 */
function classes(db: LocalDb): Record<string, unknown[]> {
	const out: Record<string, unknown[]> = {}
	for (const { name } of TABLES) {
		const columns = db.all(`PRAGMA table_info(${name})`).map((row) => String(row["name"]))
		const read = columns
			.flatMap((column) => [
				`typeof(${column}) AS "${column} class"`,
				`CASE typeof(${column}) WHEN 'blob' THEN hex(${column}) ELSE ${column} END AS ${column}`,
			])
			.join(", ")
		out[name] = db.all(`SELECT ${read} FROM ${name} ORDER BY id`)
	}
	return out
}

describe("the libsql proof's seed (SL3n of r22)", () => {
	it.each([0, 1])("stores each value in the class bun:sqlite stores it, seed %i", async (variant) => {
		const runtime = await copyOf(TABLES, { json: new Set(), variant }, "runtime")
		const libsql = await copyOf(TABLES, { json: new Set(), variant }, "libsql")
		try {
			expect(runtime.unproven).toEqual(new Map())
			expect(libsql.unproven).toEqual(new Map())
			expect(classes(libsql.db)).toEqual(classes(runtime.db))
		} finally {
			runtime.db.close()
			libsql.db.close()
		}
	})
})
