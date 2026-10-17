import { existsSync, readFileSync } from "node:fs"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { describe, expect, it } from "vitest"
import type { Run, RunOptions, RunResult } from "../core/process.ts"
import type { D1ProviderConfig, ResolvedDatabaseConfig } from "../types.ts"
import { createD1Provider } from "./d1.ts"

type Call = { cmd: string; args: readonly string[]; options: RunOptions | undefined }

function fakeRun(answer: (call: Call) => RunResult): Run & { calls: Call[] } {
	const calls: Call[] = []
	const fake = (cmd: string, args: readonly string[], options?: RunOptions) => {
		const call = { args, cmd, options }
		calls.push(call)
		return answer(call)
	}
	return Object.assign(fake, { calls })
}

const json = (value: unknown): RunResult => ({ code: 0, stderr: "", stdout: JSON.stringify(value) })

const CONFIG: D1ProviderConfig = { databaseId: "id", databaseName: "core", type: "d1" }
const DB: ResolvedDatabaseConfig = { migrationsDir: "m", name: "core-local", provider: CONFIG }

async function connect(run: Run, config: D1ProviderConfig = CONFIG) {
	return createD1Provider(config, run).connect(DB)
}

describe("createD1Provider: execute", () => {
	it("runs wrangler against the resolved database name, remote by default, and maps rows to columns", async () => {
		const run = fakeRun(() =>
			json([
				{
					results: [
						{ a: 1, b: "x" },
						{ a: 2, b: "y" },
					],
					success: true,
				},
			]),
		)
		const conn = await connect(run)
		expect(conn.dialect).toBe("sqlite")
		expect(await conn.execute("SELECT a, b FROM t")).toEqual({
			columns: ["a", "b"],
			rows: [
				[1, "x"],
				[2, "y"],
			],
		})
		expect(run.calls).toEqual([
			{
				args: ["d1", "execute", "core-local", "--remote", "--json", "--command=SELECT a, b FROM t"],
				cmd: "wrangler",
				options: undefined,
			},
		])
	})

	it("targets the local database when local is set", async () => {
		const run = fakeRun(() => json([{ results: [] }]))
		const conn = await connect(run, { ...CONFIG, local: true })
		await conn.execute("SELECT 1")
		expect(run.calls[0]?.args).toEqual(["d1", "execute", "core-local", "--local", "--json", "--command=SELECT 1"])
	})
})

describe("createD1Provider: parameters and output", () => {
	it("inlines every supported parameter type as a SQL literal", async () => {
		const run = fakeRun(() => json([{ results: [] }]))
		const conn = await connect(run)
		await conn.execute("? ? ? ? ? ? ? ?", [null, undefined, 1.5, 10n, true, false, new Date(42), "it's"])
		expect(run.calls[0]?.args.at(-1)).toBe("--command=NULL NULL 1.5 10 1 0 42 'it''s'")
	})

	it("rejects parameters it cannot inline", async () => {
		const conn = await connect(fakeRun(() => json([{ results: [] }])))
		await expect(conn.execute("?", [Number.NaN])).rejects.toThrow("Invalid numeric literal: NaN")
		await expect(conn.execute("?", [{}])).rejects.toThrow("Unsupported SQL literal: object")
		await expect(conn.execute("? ?", [1])).rejects.toThrow("Not enough params for SQL placeholders")
	})

	it("returns no rows for empty output", async () => {
		const empty = { columns: [], rows: [] }
		expect(await (await connect(fakeRun(() => json([{ results: [] }])))).execute("x")).toEqual(empty)
		expect(await (await connect(fakeRun(() => json([])))).execute("x")).toEqual(empty)
	})

	it("throws wrangler's stderr, or stdout when stderr is empty, on a nonzero exit", async () => {
		const failing = await connect(fakeRun(() => ({ code: 1, stderr: " no such table: t \n", stdout: "" })))
		await expect(failing.execute("x")).rejects.toThrow("wrangler failed (exit 1): no such table: t")
		const quiet = await connect(fakeRun(() => ({ code: 2, stderr: "", stdout: "auth required" })))
		await expect(quiet.execute("x")).rejects.toThrow("wrangler failed (exit 2): auth required")
	})
})

describe("createD1Provider: batch and close", () => {
	it("writes the statements to a temp file, runs it, and removes the file", async () => {
		let file = ""
		let body = ""
		const run = fakeRun((call) => {
			file = (call.args.at(-1) as string).replace(/^--file=/, "")
			body = readFileSync(file, "utf8")
			return json([])
		})
		const conn = await connect(run, { ...CONFIG, local: true })
		await conn.batch([{ sql: "CREATE TABLE a (x)" }, { sql: "CREATE TABLE b (y)" }])
		expect(body).toBe("CREATE TABLE a (x)\n;\nCREATE TABLE b (y)\n;")
		expect(run.calls[0]?.args.slice(0, 4)).toEqual(["d1", "execute", "core-local", "--local"])
		expect(existsSync(file)).toBe(false)
	})

	it("removes the temp file when wrangler fails", async () => {
		let file = ""
		const conn = await connect(
			fakeRun((call) => {
				file = (call.args.at(-1) as string).replace(/^--file=/, "")
				return { code: 1, stderr: "bad sql", stdout: "" }
			}),
		)
		await expect(conn.batch([{ sql: "nope" }])).rejects.toThrow("wrangler failed (exit 1): bad sql")
		expect(existsSync(file)).toBe(false)
	})

	it("close resolves without running anything", async () => {
		const run = fakeRun(() => json([]))
		await (await connect(run)).close()
		expect(run.calls).toEqual([])
	})
})

describe("createD1Provider: SQL it hands wrangler (S-13)", () => {
	it("terminates every batch statement so a trailing comment cannot swallow the next one", async () => {
		let file = ""
		const run = fakeRun((call) => {
			const arg = call.args.find((a) => a.startsWith("--file="))
			if (arg) file = readFileSync(arg.slice("--file=".length), "utf8")
			return json([])
		})
		const conn = await connect(run)
		await conn.batch([
			{ sql: "CREATE TABLE a (x) -- the first" },
			{ sql: "CREATE TABLE b (y) /* and the second" },
			{ sql: "CREATE TABLE c (z)" },
		])
		const db = libsqlConnection()
		try {
			await db.client.executeMultiple(file)
			const { rows } = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			expect(rows.map((row) => row[0])).toEqual(["a", "b", "c"])
		} finally {
			await db.close()
		}
	})

	it("inlines a batch statement's parameters into the file, since --file binds none", async () => {
		let file = ""
		const run = fakeRun((call) => {
			const arg = call.args.find((a) => a.startsWith("--file="))
			if (arg) file = readFileSync(arg.slice("--file=".length), "utf8")
			return json([])
		})
		const conn = await connect(run)
		await conn.batch([
			{ sql: "CREATE TABLE t (h TEXT, at INTEGER)" },
			{ params: ["it's", 7], sql: "INSERT INTO t VALUES (?, ?)" },
		])
		expect(file).toBe("CREATE TABLE t (h TEXT, at INTEGER)\n;\nINSERT INTO t VALUES ('it''s', 7)\n;")
	})

	it("inlines parameters only for placeholders in code, never a ? inside a literal or comment", async () => {
		const run = fakeRun(() => json([{ results: [] }]))
		const conn = await connect(run)
		await conn.execute("SELECT '?' AS q, ? AS v -- why?\n, ? AS w", [5, "it's"])
		const command = run.calls[0]?.args.find((a) => a.startsWith("--command="))
		expect(command).toBe("--command=SELECT '?' AS q, 5 AS v -- why?\n, 'it''s' AS w")
	})

	it("throws when wrangler's output is not the JSON it documents, instead of returning no rows", async () => {
		for (const stdout of ["not json", JSON.stringify({ results: [] })]) {
			const conn = await connect(fakeRun(() => ({ code: 0, stderr: "", stdout })))
			await expect(conn.execute("SELECT 1")).rejects.toThrow(/wrangler/)
		}
	})
})
