import { describe, expect, it, vi } from "vitest"
import { wranglerBin } from "../../cli/__fixtures__/d1.ts"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { enclosing, proveOnD1, refuseRewritten } from "./d1-engine.ts"
import { notEngineTables } from "./engine-tables.ts"
import { creatable, liveObjects } from "./proof-copy.ts"

vi.mock("bun:sqlite", () => import("../__fixtures__/bun-sqlite-node.ts"))

const LIVE = "CREATE TABLE t (id INTEGER PRIMARY KEY, v REAL NOT NULL DEFAULT 1);\nINSERT INTO t (v) VALUES (2), (3);"

/** `files` proven on the checked wrangler's D1, over a live database holding t; resolves to what it threw */
async function proven(files: Array<{ name: string; sql: string }>, table = "d1_migrations"): Promise<unknown> {
	const live = libsqlConnection()
	try {
		await live.client.executeMultiple(LIVE)
		const objects = creatable(await liveObjects(live, notEngineTables(live)))
		return await proveOnD1(objects, files, { bin: wranglerBin(), table }).catch((error: unknown) => error)
	} finally {
		await live.close()
	}
}

describe("refuseRewritten: the text wrangler --local rewrites (SD2 of r22)", () => {
	it("passes a file without the words, and one with COMMIT; alone, which wrangler leaves", () => {
		expect(() => refuseRewritten({ name: "1.sql", sql: "INSERT INTO t (b) VALUES ('COMMIT;')" })).not.toThrow()
	})

	it.each([
		["INSERT INTO t (b) VALUES ('a BEGIN TRANSACTION; b');", "'a BEGIN TRANSACTION; b'"],
		["-- BEGIN TRANSACTION here\nCREATE TABLE a (x);", "-- BEGIN TRANSACTION here"],
		["/* BEGIN TRANSACTION */ CREATE TABLE a (x);", "/* BEGIN TRANSACTION */"],
		['CREATE TABLE "BEGIN TRANSACTION" (x);', '"BEGIN TRANSACTION"'],
		["CREATE TABLE [BEGIN TRANSACTION] (x);", "[BEGIN TRANSACTION]"],
	])("refuses %j, naming %s, wrangler's rewrite and the remedy", (sql, where) => {
		expect(() => refuseRewritten({ name: "1.sql", sql })).toThrow(
			`1.sql: ${where} holds "BEGIN TRANSACTION", and wrangler rewrites`,
		)
		expect(() => refuseRewritten({ name: "1.sql", sql })).toThrow(/as in 'BEGIN ' \|\| 'TRANSACTION'$/)
	})

	it("names the text itself where the words stand outside any literal or comment", () => {
		expect(enclosing("BEGIN TRANSACTION;", 0)).toBe("its text")
	})
})

describe("proveOnD1: each file on D1's own engine (SD1 of r22)", () => {
	it("passes files D1 runs, its history row appended to a table of any name", async () => {
		const files = [
			{ name: "1_box.sql", sql: "CREATE VIRTUAL TABLE box USING rtree (id, x0, x1);" },
			{ name: "2_o'pt.sql", sql: "CREATE INDEX t_v ON t (v);\nPRAGMA optimize(65538);" },
			{ name: "3_tr.sql", sql: "CREATE TRIGGER t_up AFTER UPDATE OF v ON t BEGIN SELECT abs(new.v); END;" },
		]
		expect(await proven(files, 'my "history"')).toBeUndefined()
	}, 120_000)

	it("refuses a file D1 refuses as it runs, naming D1's error", async () => {
		const failure = await proven([
			{ name: "1_ok.sql", sql: "CREATE TABLE a (x);" },
			{ name: "2_sq.sql", sql: "ALTER TABLE t ADD COLUMN sq REAL;\nUPDATE t SET sq = power(v, 2);" },
		])
		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).toMatch(
			/^2_sq\.sql: D1 refuses this file on its own engine, as wrangler's apply would: .*not authorized to use function: power/,
		)
	}, 120_000)

	it("refuses a generated column D1 refuses as it creates it", async () => {
		const failure = (await proven([
			{
				name: "1_g.sql",
				sql: "CREATE TABLE g (id INTEGER PRIMARY KEY, v REAL, up REAL GENERATED ALWAYS AS (ceiling(v)) VIRTUAL);",
			},
		])) as Error
		expect(failure.message).toMatch(
			/^1_g\.sql: D1 refuses this file on its own engine, .*not authorized to use function: ceiling/,
		)
	}, 120_000)

	it.each([
		[
			"a trigger body",
			"CREATE TABLE sq (id INTEGER PRIMARY KEY, v REAL);\nCREATE TRIGGER t_sq AFTER INSERT ON t BEGIN INSERT INTO sq (id, v) VALUES (new.id, power(new.v, 2)); END;",
			/then refuses INSERT INTO "t" DEFAULT VALUES: .*not authorized to use function: power/,
		],
		[
			"a view",
			"CREATE VIEW stats AS SELECT median(v) AS med FROM t;",
			/then refuses SELECT \* FROM "stats": .*no such function: median/,
		],
	])(
		"refuses %s D1 applies and then cannot run, naming the statement and D1's error",
		async (_, sql, error) => {
			const failure = (await proven([{ name: "1_late.sql", sql }])) as Error
			expect(failure.message).toMatch(/^1_late\.sql: D1 applies this file, then refuses /)
			expect(failure.message).toMatch(error)
		},
		120_000,
	)

	it("refuses a file wrangler would rewrite before it opens D1", async () => {
		const failure = (await proven([{ name: "1.sql", sql: "SELECT 'BEGIN TRANSACTION';" }])) as Error
		expect(failure.message).toMatch(/^1\.sql: 'BEGIN TRANSACTION' holds "BEGIN TRANSACTION"/)
	})
})
