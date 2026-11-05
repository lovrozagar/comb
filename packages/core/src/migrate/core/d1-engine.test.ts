import { writeFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { wranglerBin } from "../../cli/__fixtures__/d1.ts"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { enclosing, proveOnD1, refuseRewritten } from "./d1-engine.ts"
import { notEngineTables } from "./engine-tables.ts"
import { type Run, run } from "./process.ts"
import { creatable, liveObjects } from "./proof-copy.ts"

vi.mock("bun:sqlite", () => import("../__fixtures__/bun-sqlite-node.ts"))

const LIVE = "CREATE TABLE t (id INTEGER PRIMARY KEY, v REAL NOT NULL DEFAULT 1);\nINSERT INTO t (v) VALUES (2), (3);"

/** `files` proven on the checked wrangler's D1, over a live database `schema` made (t by default); resolves to what it threw */
async function proven(
	files: Array<{ name: string; sql: string }>,
	{ exec, schema = LIVE, table = "d1_migrations" }: { exec?: Run; schema?: string; table?: string } = {},
): Promise<unknown> {
	const live = libsqlConnection()
	try {
		await live.client.executeMultiple(schema)
		const objects = creatable(await liveObjects(live, notEngineTables(live)))
		return await proveOnD1(objects, files, { bin: wranglerBin(), exec, table }).catch((error: unknown) => error)
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

	/* classify refuses a BEGIN that starts a statement, and the bun:sqlite proof only records a file SQLite cannot
	   parse, so such a file's code can hold the words */
	it("names the text, not a literal after it, where a file SQLite cannot parse holds the words in its code", () => {
		const sql = "SELECT 1 FROM t BEGIN TRANSACTION;\nINSERT INTO t VALUES ('x');"
		expect(() => refuseRewritten({ name: "1.sql", sql })).toThrow(/^1\.sql: its text holds "BEGIN TRANSACTION"/)
	})
})

describe("proveOnD1 inside a Bun single-file executable", () => {
	/* D4-5 of the area D round-four review: the child is handed a module the executable embeds, which node cannot read */
	it("refuses inside a Bun single-file executable, saying why, and starts no child", async () => {
		const calls: string[] = []
		const exec: Run = async (cmd) => {
			calls.push(cmd)
			return { code: 0, stderr: "", stdout: "" }
		}
		const files = [{ name: "1.sql", sql: "SELECT 1;" }]
		await expect(
			proveOnD1([], files, {
				bin: wranglerBin(),
				exec,
				moduleUrl: "file:///$bunfs/root/app-exe",
				table: "d1_migrations",
			}),
		).rejects.toThrow(
			new Error(
				"check proves the pending files in a child on wrangler's runtime, which cannot read the modules a Bun single-file executable embeds: run comb migrate with bun or node, not from a compiled executable",
			),
		)
		expect(calls).toEqual([])
	})
})

describe("proveOnD1: each file on D1's own engine, in a child on wrangler's runtime (SD1 of r22)", () => {
	it("passes files D1 runs, the child started on node through the runner", async () => {
		const runtimes: string[] = []
		const exec: Run = async (cmd, args, options) => {
			runtimes.push(`${cmd} ${options?.peer}`)
			return run(cmd, args, options)
		}
		expect(await proven([{ name: "1_a.sql", sql: "CREATE TABLE a (x);" }], { exec })).toEqual([])
		expect(runtimes).toEqual(["node wrangler"])
	}, 120_000)

	it("refuses a file D1 refuses, in D1's words as the child answers them", async () => {
		const failure = await proven([
			{ name: "1_ok.sql", sql: "CREATE TABLE a (x);" },
			{ name: "2_sq.sql", sql: "ALTER TABLE t ADD COLUMN sq REAL;\nUPDATE t SET sq = power(v, 2);" },
		])
		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).toMatch(
			/^2_sq\.sql: D1 refuses this file on its own engine, as wrangler's apply would: .*not authorized to use function: power.*; leave out what D1 does not run$/,
		)
	}, 120_000)

	it.each([
		[
			"a child that fails",
			{ code: 127, stderr: "node: command not found; install Node.js\n", stdout: "" },
			"127 and no answer: node: command not found; install Node.js",
		],
		["a child that answers nothing", { code: 0, stderr: "", stdout: "" }, "0 and no answer: it printed nothing"],
	])("refuses with how %s ended, naming its runtime", async (_, result, said) => {
		const failure = (await proven([{ name: "1_a.sql", sql: "CREATE TABLE a (x);" }], {
			exec: async () => result,
		})) as Error
		expect(failure.message).toBe(
			`check could not prove the pending files on D1's engine: the proof on node ended with code ${said}`,
		)
	})

	it("answers each file the child could not prove, and why, for the caller to rate", async () => {
		const unproven = [{ name: "1_a.sql", why: "comb's local D1 crashed" }]
		const exec: Run = async (_, args) => {
			writeFileSync(args.at(-1) as string, JSON.stringify({ unproven }))
			return { code: 0, stderr: "", stdout: "" }
		}
		expect(await proven([{ name: "1_a.sql", sql: "CREATE TABLE a (x);" }], { exec })).toEqual(unproven)
	})

	it("refuses a file wrangler would rewrite before it opens D1", async () => {
		const failure = (await proven([{ name: "1.sql", sql: "SELECT 'BEGIN TRANSACTION';" }])) as Error
		expect(failure.message).toMatch(/^1\.sql: 'BEGIN TRANSACTION' holds "BEGIN TRANSACTION"/)
	})
})
