import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deliver, stubKill } from "../../../tests/support/signals.ts"
import type { Run, RunOptions, RunResult } from "../core/process.ts"
import { localD1Path } from "../core/d1-binding.ts"
import type { D1ProviderConfig, ResolvedDatabaseConfig } from "../types.ts"
import { createD1Provider, executeAll } from "./d1.ts"
import { asCalled, wranglerBin } from "../../cli/__fixtures__/d1.ts"

type Call = { cmd: string; args: readonly string[]; options: RunOptions | undefined }

/* the steps a wait holds for a signal and has not let go of, through cleanup's own hold */
const unreleased = vi.hoisted(() => new Set<unknown>())
vi.mock("../core/cleanup.ts", async (original) => {
	const real = await original<typeof import("../core/cleanup.ts")>()
	return {
		...real,
		hold: (step: Parameters<typeof real.hold>[0]) => {
			const release = real.hold(step)
			unreleased.add(step)
			return () => {
				unreleased.delete(step)
				release()
			}
		},
	}
})

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
			await executeAll(two, { flags: ["--local"], held: async () => false, name: "core", wrangler: wranglerBin() }, [
				"SELECT 1 AS n",
				"CREATE TABLE t (x)",
			]),
		).toEqual([[{ n: 1 }], []])
		const one = fakeRun(() => json([{ results: [] }]))
		await expect(
			executeAll(one, { flags: [], held: async () => false, name: "core", wrangler: wranglerBin() }, [
				"SELECT 1",
				"SELECT 2",
			]),
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

/* wrangler's answer when another process holds the local D1 file's write lock, workerd's own words, stack cut */
const BUSY: RunResult = {
	code: 1,
	stderr:
		"workerd/util/sqlite.c++:1733: failed: SQLite failed; dbErrorMessage(err, db) = database is locked: SQLITE_BUSY stack: 7f0a 7f0b",
	stdout: '{ "error": { "text": "Failed to parse body as JSON, got: Error: internal error; reference = x1" } }',
}
/* the same, as wrangler prints it without --json: colored, on stderr */
const BUSY_COLORED: RunResult = {
	code: 1,
	stderr:
		"\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mdatabase is locked: SQLITE_BUSY\u001b[0m\n",
	stdout: "",
}
const LOCAL: D1ProviderConfig = { ...CONFIG, local: true }
const LOCKED =
	"wrangler failed (exit 1): the local D1 database stayed locked by another process (wrangler dev, a wrangler command or a second comb migrate) for 5 s: let it finish and rerun"

/** A runner answering each call with the next of `answers`, the last one ever after */
const answering = (...answers: RunResult[]) => {
	let i = 0
	return fakeRun(() => answers[Math.min(i++, answers.length - 1)] as RunResult)
}

/** A promise's value where its rejection was awaited: a failure itself */
const unexpected = (value: unknown): Error => new Error(`resolved where a rejection was due: ${JSON.stringify(value)}`)

/** The timers and clock the lock waits run on, faked for each test of the describe that calls it */
function fakeClock(): void {
	beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }))
	afterEach(() => vi.useRealTimers())
}

/* a --local request takes the file's write lock even to read, and fails at once while another process holds it */
/* a cold miniflare start on a loaded machine can take longer than the whole window */
const slowly =
	(run: Run): Run =>
	async (...args) => {
		await new Promise((resolve) => setTimeout(resolve, 6000))
		return run(...args)
	}

describe("createD1Provider: how long a local database another process has locked is waited for", () => {
	fakeClock()

	/* AD7-12 of the area D round-seven review: a 100 ms loop of wrangler spawns, or a 1 s window, passed */
	it("runs a busy request again at 100, 300 and 700 ms, doubling, and refuses at 5 s, not before", async () => {
		const start = Date.now()
		const at: number[] = []
		const run = fakeRun(() => {
			at.push(Date.now() - start)
			return BUSY
		})
		let settled = false
		const failed = (await connect(run, LOCAL)).execute("x").then(unexpected, (error: unknown) => error as Error)
		void failed.then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(4999)
		const early = settled
		await vi.advanceTimersByTimeAsync(1)
		expect([at, early, (await failed).message]).toEqual([[0, 100, 300, 700, 1500, 3100, 5000], false, LOCKED])
	})

	it("lets go of what it held for a signal once each wait ends", async () => {
		unreleased.clear()
		const run = answering(BUSY, BUSY, json([{ results: [{ n: 1 }] }]))
		const rows = (await connect(run, LOCAL)).execute("SELECT 1 AS n")
		await vi.advanceTimersByTimeAsync(1000)
		await rows
		expect(unreleased.size).toBe(0)
	})
})

describe("createD1Provider: a local database another process has locked", () => {
	fakeClock()

	it("runs a busy request again once the lock is let go, and answers its rows", async () => {
		const run = answering(BUSY, BUSY, json([{ results: [{ n: 1 }] }]))
		const rows = (await connect(run, LOCAL)).execute("SELECT 1 AS n")
		await vi.advanceTimersByTimeAsync(1000)
		expect(await rows).toEqual({ columns: ["n"], rows: [[1]] })
		expect(run.calls.map(({ args }) => args)).toEqual(Array(3).fill(run.calls[0]?.args))
	})

	it("reruns only the busy one of a batch's commands", async () => {
		const run = answering(json([]), BUSY_COLORED, json([]))
		const long = Array.from({ length: 3 }, (_, i) => ({
			sql: `INSERT INTO t VALUES ('${String(i).repeat(50 * 1024)}')`,
		}))
		const done = (await connect(run, LOCAL)).batch(long)
		await vi.advanceTimersByTimeAsync(1000)
		await done
		const values = run.calls.map(({ args }) => args.at(-1)?.slice("--command=INSERT INTO t VALUES ('".length).at(0))
		expect(values).toEqual(["0", "1", "1", "2"])
	})

	it("refuses, naming the lock and no workerd stack, once it has stayed busy for 5 s", async () => {
		const run = answering(BUSY)
		const failed = (await connect(run, LOCAL)).execute("SELECT 1").then(unexpected, (error: unknown) => error as Error)
		await vi.advanceTimersByTimeAsync(5000)
		expect((await failed).message).toBe(LOCKED)
		const ran = run.calls.length
		await vi.advanceTimersByTimeAsync(5000)
		expect([ran > 2, run.calls.length]).toEqual([true, ran])
	})

	it("waits out a lock its first run met, however long that run took to start", async () => {
		const run = answering(BUSY, json([{ results: [{ n: 1 }] }]))
		const rows = (await connect(slowly(run), LOCAL)).execute("SELECT 1 AS n")
		await vi.advanceTimersByTimeAsync(20_000)
		expect([await rows, run.calls.length]).toEqual([{ columns: ["n"], rows: [[1]] }, 2])
	})

	it("counts the 5 s from the first busy answer, not from the first start", async () => {
		const run = answering(BUSY)
		const failed = (await connect(slowly(run), LOCAL)).execute("x").then(unexpected, (error: unknown) => error as Error)
		await vi.advanceTimersByTimeAsync(60_000)
		expect([run.calls.length > 1, (await failed).message]).toEqual([true, LOCKED])
	})
})

/* CI on 84332342: wrangler's answer names only an internal error, and a run can end before workerd's line is forwarded */
/** A local config whose wrangler config binds `core`, and its database file, made */
function project(): { config: D1ProviderConfig; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-d1-held-"))
	const wranglerConfig = path.join(dir, "wrangler.json")
	const d1 = { binding: "DB", database_id: "id-core", database_name: "core" }
	fs.writeFileSync(wranglerConfig, JSON.stringify({ d1_databases: [d1], name: "w" }))
	const file = localD1Path(dir, d1)
	fs.mkdirSync(path.dirname(file), { recursive: true })
	new DatabaseSync(file).close()
	return { config: { ...LOCAL, wranglerConfig }, file }
}

/* on real timers: the file is found through the real wrangler's config reader, which fake timers stall */
describe("createD1Provider: a local lock wrangler's output does not name", () => {
	const LOST: RunResult = { code: 1, stderr: "", stdout: '{"error":{"text":"internal error; reference = r1"}}' }

	it("waits out a lock SQLite reports on the file the config binds", async () => {
		const { config, file } = project()
		const holder = new DatabaseSync(file)
		holder.exec("BEGIN IMMEDIATE")
		const run = fakeRun(() => {
			if (run.calls.length === 1) return LOST
			holder.exec("ROLLBACK")
			holder.close()
			return json([{ results: [{ n: 1 }] }])
		})
		const rows = await (await connect(run, config)).execute("SELECT 1 AS n")
		expect([rows, run.calls.length]).toEqual([{ columns: ["n"], rows: [[1]] }, 2])
	})

	it("runs once, and throws wrangler's error, when the file is not locked", async () => {
		const run = answering(LOST, json([]))
		await expect((await connect(run, project().config)).execute("x")).rejects.toThrow(
			`wrangler failed (exit 1): ${LOST.stdout}`,
		)
		expect(run.calls.length).toBe(1)
	})
})

describe("createD1Provider: a lock comb does not wait out", () => {
	const kill = stubKill()
	fakeClock()

	it("runs once a failure that says locked in another sense, or a remote one", async () => {
		const other: RunResult = {
			code: 1,
			stderr: "database is locked: SQLITE_BUSY_RECOVERY; table t is locked: SQLITE_LOCKED",
			stdout: "",
		}
		const locked = answering(other, json([]))
		await expect((await connect(locked, LOCAL)).execute("x")).rejects.toThrow(
			"wrangler failed (exit 1): database is locked: SQLITE_BUSY_RECOVERY",
		)
		const remote = answering(BUSY, json([]))
		await expect((await connect(remote)).execute("x")).rejects.toThrow(/^wrangler failed \(exit 1\): workerd/)
		expect([locked.calls.length, remote.calls.length]).toEqual([1, 1])
	})

	it("starts no wrangler again once a signal stops comb while it waits", async () => {
		const run = answering(BUSY, json([]))
		const failed = (await connect(run, LOCAL)).execute("x").then(unexpected, (error: unknown) => error as Error)
		await vi.advanceTimersByTimeAsync(0)
		await deliver("SIGTERM")
		expect((await failed).message).toBe(
			"wrangler failed (exit 1): comb stopped (SIGTERM) while the local D1 database was locked by another process",
		)
		await vi.advanceTimersByTimeAsync(5000)
		expect([run.calls.length, kill.calls()]).toEqual([1, [[process.pid, "SIGTERM"]]])
	})
})
