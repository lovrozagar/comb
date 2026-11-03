import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { objectDrift } from "./baseline-sqlite-objects.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-baseline-objects-"))
	mkdirSync(join(dir, "m"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const TABLE = "CREATE TABLE t (id INTEGER PRIMARY KEY, emb F32_BLOB(3));"
const VECTOR = "CREATE INDEX t_emb ON t (libsql_vector_idx(emb));"

describe("objectDrift on a libsql target (SL3 of r22)", () => {
	it("replays a vector index on libsql's engine and finds the database's the same", async () => {
		writeFileSync(join(dir, "m", "1_t.sql"), TABLE)
		writeFileSync(join(dir, "m", "2_vec.sql"), VECTOR)
		const conn = libsqlConnection()
		await conn.client.executeMultiple(`${TABLE} ${VECTOR}`)
		expect(await objectDrift(conn, join(dir, "m"), "libsql")).toEqual([])
		await conn.close()
	})

	it("names a vector index only one side has, or each side defines its own way", async () => {
		writeFileSync(join(dir, "m", "1_t.sql"), `${TABLE} ${VECTOR}`)
		const conn = libsqlConnection()
		await conn.client.executeMultiple(
			`${TABLE} CREATE INDEX t_emb ON t (libsql_vector_idx(emb, 'metric=l2')); CREATE INDEX t_other ON t (libsql_vector_idx(emb));`,
		)
		expect(await objectDrift(conn, join(dir, "m"), "libsql")).toEqual([
			"-- vector index t_emb: the database has CREATE INDEX t_emb ON t (libsql_vector_idx(emb, 'metric=l2')), the migrations CREATE INDEX t_emb ON t (libsql_vector_idx(emb))",
			"-- vector index t_other: only in the database",
		])
		await conn.close()
	})

	it("refuses a history the runtime's SQLite cannot replay, naming the file", async () => {
		writeFileSync(join(dir, "m", "1_t.sql"), `${TABLE} ${VECTOR}`)
		const conn = libsqlConnection()
		await expect(objectDrift(conn, join(dir, "m"), "runtime")).rejects.toThrow(
			/^comb could not replay 1_t\.sql to compare its triggers and views: .*libsql_vector_idx/,
		)
		await conn.close()
	})
})
