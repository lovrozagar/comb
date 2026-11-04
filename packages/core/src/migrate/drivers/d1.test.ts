import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { describe, expect, it } from "vitest"
import type { Run, RunOptions, RunResult } from "../core/process.ts"
import type { D1ProviderConfig, ResolvedDatabaseConfig } from "../types.ts"
import { createD1Provider, executeAll } from "./d1.ts"
import { asCalled, wranglerBin } from "../../cli/__fixtures__/d1.ts"

type Call = { cmd: string; args: readonly string[]; options: RunOptions | undefined }

/** A runner that answers each call, recording a wrangler spawn as `wrangler` and its own arguments; `spawns` keeps them raw */
function fakeRun(answer: (call: Call) => RunResult): Run & { calls: Call[]; spawns: Call[] } {
	const calls: Call[] = []
	const spawns: Call[] = []
	const fake = async (spawned: string, argv: readonly string[], options?: RunOptions) => {
		spawns.push({ args: argv, cmd: spawned, options })
		const [cmd, args] = asCalled(spawned, argv, options?.peer)
		const call = { args, cmd, options }
		calls.push(call)
		return answer(call)
	}
	return Object.assign(fake, { calls, spawns })
}

const json = (value: unknown): RunResult => ({ code: 0, stderr: "", stdout: JSON.stringify(value) })

const CONFIG: D1ProviderConfig = { databaseName: "core", type: "d1" }
const DB: ResolvedDatabaseConfig = { migrationsDir: "m", name: "core-local", provider: CONFIG }

async function connect(run: Run, config: D1ProviderConfig = CONFIG) {
	return createD1Provider(config, run).connect(DB)
}

/* R1: several statements in one wrangler process, each answered */
describe("executeAll", () => {
	it("runs every statement in one wrangler call, and refuses an answer that leaves one out", async () => {
		const two = fakeRun(() => json([{ results: [{ n: 1 }] }, { results: [] }]))
		expect(
			await executeAll(two, { flags: ["--local"], name: "core", wrangler: wranglerBin() }, [
				"SELECT 1 AS n",
				"CREATE TABLE t (x)",
			]),
		).toEqual([[{ n: 1 }], []])
		const one = fakeRun(() => json([{ results: [] }]))
		await expect(
			executeAll(one, { flags: [], name: "core", wrangler: wranglerBin() }, ["SELECT 1", "SELECT 2"]),
		).rejects.toThrow("wrangler answered 1 results for 2 statements")
	})
})

describe("createD1Provider: execute", () => {
	/* K4 of r17: the provider's databaseName, never the environment's name the resolved config carries */
	it("runs wrangler against the provider's databaseName, remote by default, and maps rows to columns", async () => {
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
				args: ["d1", "execute", "core", "--remote", "--json", "--command=SELECT a, b FROM t"],
				cmd: "wrangler",
				options: { peer: "wrangler" },
			},
		])
		/* K1 of r22: the wrangler the working folder's project holds, its bin on node, never a name on PATH */
		expect(run.spawns[0]?.cmd).toBe("node")
		expect(run.spawns[0]?.args.slice(0, 3)).toEqual([wranglerBin().bin, "d1", "execute"])
	})

	it("targets the local database when local is set", async () => {
		const run = fakeRun(() => json([{ results: [] }]))
		const conn = await connect(run, { ...CONFIG, local: true })
		await conn.execute("SELECT 1")
		expect(run.calls[0]?.args).toEqual(["d1", "execute", "core", "--local", "--json", "--command=SELECT 1"])
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

/** The name of the `i`th migration, as long as a real one */
const migrationName = (i: number) => `${String(i).padStart(14, "0")}_add_some_table.sql`

/* S8 of the 0.15.0 review: a remote --file goes through D1's import API, which takes the database out of service */
describe("createD1Provider: batch and close", () => {
	it("sends the statements as one --command, which D1's query API runs", async () => {
		const run = fakeRun(() => json([]))
		const conn = await connect(run, { ...CONFIG, local: false })
		await conn.batch([{ sql: "CREATE TABLE a (x)" }, { sql: "CREATE TABLE b (y)" }])
		expect(run.calls.map(({ args }) => args)).toEqual([
			["d1", "execute", "core", "--remote", "--command=CREATE TABLE a (x)\n;\nCREATE TABLE b (y)\n;"],
		])
	})

	/* r18 S4: a batch past one argument went through --file, D1's import API, on the run that adopts a long history */
	it("splits a batch too long for one argument into consecutive --command calls, in order", async () => {
		const run = fakeRun(() => json([]))
		const conn = await connect(run, { ...CONFIG, local: false })
		/* a hash row as recordHashes writes it, 173 bytes with its terminator, so 590 pass the 100 KiB cap */
		const statements = Array.from({ length: 590 }, (_, i) => ({
			sql: `INSERT OR REPLACE INTO _comb_migration_hashes (name, hash) VALUES ('${migrationName(i)}', '${"h".repeat(64)}')`,
		}))
		await conn.batch(statements)
		const commands = run.calls.map(({ args }) => args.at(-1) as string)
		expect(run.calls.map(({ args }) => args.slice(0, 4))).toEqual([
			["d1", "execute", "core", "--remote"],
			["d1", "execute", "core", "--remote"],
		])
		expect(commands.every((arg) => arg.startsWith("--command="))).toBe(true)
		const sent = commands.map((arg) => arg.slice("--command=".length))
		expect(sent.every((sql) => Buffer.byteLength(sql) <= 100 * 1024)).toBe(true)
		expect(sent.join("\n")).toBe(statements.map(({ sql }) => `${sql}\n;`).join("\n"))
	})

	it("runs nothing for an empty batch", async () => {
		const run = fakeRun(() => json([]))
		await (await connect(run)).batch([])
		expect(run.calls).toEqual([])
	})

	it("refuses one statement too long for an argument before wrangler runs", async () => {
		const run = fakeRun(() => json([]))
		const conn = await connect(run)
		await expect(conn.batch([{ sql: `SELECT '${"x".repeat(100 * 1024)}'` }])).rejects.toThrow(
			"is longer than one wrangler argument takes",
		)
		expect(run.calls).toEqual([])
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
			const arg = call.args.find((a) => a.startsWith("--command="))
			if (arg) file = arg.slice("--command=".length)
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

	it("inlines a batch statement's parameters, since a batch binds none", async () => {
		let file = ""
		const run = fakeRun((call) => {
			const arg = call.args.find((a) => a.startsWith("--command="))
			if (arg) file = arg.slice("--command=".length)
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
