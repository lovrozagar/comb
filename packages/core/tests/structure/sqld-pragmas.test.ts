/**
 * comb's rule of what a libsql server (sqld) runs is the pinned server's own (S1 of r22): this starts
 * the pinned sqld (tests/support/sqld.ts), sends every name its `pragma_list` holds as a read and as a
 * set, quoted names, and the statement classes, and fails when the server's refusals and comb's
 * differ. A missing binary or one that is not the pinned build fails it rather than skipping it.
 */
import { createClient } from "@libsql/client"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { refuseUnrunnable } from "../../src/migrate/core/classify-file.ts"
import { codeOf } from "../../src/migrate/core/sql-code.ts"
import { requireSqld, type Sqld, SQLD_PATH, SQLD_VERSION, startSqld } from "../support/sqld.ts"

/** Whether comb refuses `stmt` on a sqld target as sqld's */
function combRefuses(stmt: string): boolean {
	try {
		refuseUnrunnable({ code: codeOf(stmt, "sqlite"), dialect: "sqlite", stmt }, stmt, "sqld")
		return false
	} catch (error) {
		return /libsql server \(sqld\)/.test((error as Error).message)
	}
}

/* every class r22 S1 found, the spellings each is read by, and statements sqld runs beside them */
const STATEMENTS = [
	"ANALYZE",
	"analyze probe",
	"ANALYZE main",
	"ATTACH DATABASE 'x.db' AS x",
	"attach ':memory:' as m",
	"CREATE TEMP TABLE tt (a)",
	"CREATE TEMPORARY TABLE tt (a)",
	"CREATE TEMP TABLE IF NOT EXISTS tt (a)",
	"CREATE TEMP VIEW tv AS SELECT 1",
	"CREATE TEMP TRIGGER ttr AFTER INSERT ON probe BEGIN SELECT 1; END",
	"CREATE TABLE temp.tt (a)",
	"CREATE TABLE IF NOT EXISTS TEMP.tt (a)",
	"CREATE TABLE temp.tt AS SELECT 1",
	"CREATE VIRTUAL TABLE temp.f USING fts5 (b)",
	'CREATE TABLE "temp".tq (a)',
	"CREATE VIEW temp.tv2 AS SELECT 1",
	"CREATE TRIGGER temp.tr2 AFTER INSERT ON probe BEGIN SELECT 1; END",
	"SELECT load_extension('x')",
	"SELECT LOAD_EXTENSION('x', 'y')",
	"REINDEX probe",
	"SAVEPOINT s",
	"CREATE VIRTUAL TABLE f USING fts5 (b)",
	"CREATE VIRTUAL TABLE r USING rtree (id, a, b)",
	"CREATE TABLE t7 AS SELECT 1",
	"CREATE VIEW v7 AS SELECT 1",
	"INSERT INTO probe (a) VALUES (1) RETURNING a",
	"WITH x AS (SELECT 1) SELECT * FROM x",
]

/* the spellings of a pragma's name sqld's parser tells apart */
const SPELLINGS = [
	"PRAGMA USER_VERSION = 1",
	'PRAGMA "user_version" = 1',
	"PRAGMA [user_version] = 1",
	"PRAGMA `user_version` = 1",
	'PRAGMA "main".foreign_keys = 1',
	'PRAGMA main."foreign_keys" = 1',
	"PRAGMA main.table_info(probe)",
	"pragma table_info ( probe )",
	"PRAGMA foreign_keys = 'on'",
	"PRAGMA no_such_pragma",
	"PRAGMA no_such_pragma = 1",
]

let server: Sqld

/**
 * Whether sqld refuses `stmt` before it runs anything (at parse) or by its authorizer; one it runs and SQLite then
 * fails (`PRAGMA foreign_key_check = 0`: no such table) is SQLite's failure, which the proof meets, not sqld's
 */
async function sqldRefuses(stmt: string): Promise<boolean> {
	const client = createClient({ url: server.http })
	try {
		await client.batch(["CREATE TABLE IF NOT EXISTS probe (a)", stmt], "write")
		return false
	} catch (error) {
		return /unsupported statement|not authorized/.test((error as Error).message)
	} finally {
		client.close()
	}
}

beforeAll(async () => {
	server = await startSqld()
})
afterAll(async () => {
	await server.stop()
})

describe(`comb's sqld rule against the pinned sqld ${SQLD_VERSION} (S1 of r22)`, () => {
	it("refuses exactly the pragmas sqld refuses, every pragma_list name read and set", async () => {
		const client = createClient({ url: server.http })
		const names = (await client.execute("PRAGMA pragma_list")).rows.map((row) => String(row[0]))
		client.close()
		expect(names.length).toBeGreaterThan(60)
		const differ: string[] = []
		for (const name of names)
			for (const stmt of [`PRAGMA ${name}`, `PRAGMA ${name} = 0`])
				if ((await sqldRefuses(stmt)) !== combRefuses(stmt)) differ.push(stmt)
		expect(differ).toEqual([])
	}, 60_000)

	it.each([...SPELLINGS, ...STATEMENTS])("refuses %j exactly when sqld does", async (stmt) => {
		expect(combRefuses(stmt)).toBe(await sqldRefuses(stmt))
	})
})

describe("the pinned sqld", () => {
	it("is the pinned build at its path, which every start checks", () => {
		expect(requireSqld()).toBe(SQLD_PATH)
	})

	it("fails, never skips, when the binary is missing or is not the pinned build", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-sqld-pin-"))
		try {
			expect(() => requireSqld(path.join(dir, "sqld"))).toThrow(/is not at .*required.*sha256sum -c/)
			fs.writeFileSync(path.join(dir, "sqld"), "not sqld")
			expect(() => requireSqld(path.join(dir, "sqld"))).toThrow(/has sha256 [0-9a-f]{64}, not sqld/)
		} finally {
			fs.rmSync(dir, { force: true, recursive: true })
		}
	})
})
