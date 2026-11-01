import { beforeAll, describe, expect, it } from "vitest"
import { readLiveObjects } from "./pg-live-objects.ts"
import { CATALOG } from "./pg-live-catalog.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { cutConcurrently, replayCatalog, replayStatements } from "./pg-replay.ts"
import { makesCompared } from "./pg-replay-gate.ts"
import { parsePostgres } from "./pg-parser.ts"
import { ReplayFailed } from "./replay-failed.ts"

beforeAll(loadPostgresParser)

const tree = (sql: string) => parsePostgres(sql).stmts
const file = (sql: string) => [{ name: "1_a.sql", sql }]
const TARGET = { devUrl: "postgres://dev/dev", lockTimeout: "5s", schema: "public", url: "postgres://app/app" }

describe("cutConcurrently (P5 of r19, ruled: the tree decides, the scanner cuts, the reparse proves)", () => {
	it.each([
		[
			"CREATE INDEX CONCURRENTLY \"concurrently\" ON t (a) WHERE b <> 'concurrently' /* concurrently */",
			"CREATE INDEX \"concurrently\" ON t (a) WHERE b <> 'concurrently' /* concurrently */",
		],
		[
			"-- build concurrently\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a)",
			"-- build concurrently\nCREATE UNIQUE INDEX IF NOT EXISTS i ON t (a)",
		],
		["DROP INDEX CONCURRENTLY IF EXISTS i", "DROP INDEX IF EXISTS i"],
		["REINDEX TABLE CONCURRENTLY t", "REINDEX TABLE t"],
	])("cuts only the keyword of %j", (sql, want) => {
		expect(cutConcurrently(sql, tree(sql))).toBe(want)
	})

	it("refuses a REINDEX whose option list the cut would leave empty, which the parser refuses: loud, never guessed", () => {
		const sql = "REINDEX (CONCURRENTLY) INDEX i"
		expect(() => cutConcurrently(sql, tree(sql))).toThrow(/comb could not replay .* without CONCURRENTLY/)
	})

	it("refuses when the tree names the flag and the code holds no CONCURRENTLY to cut, only quoted and literal ones", () => {
		const sql = "CREATE INDEX \"concurrently\" ON t (a) WHERE b <> 'concurrently'"
		const flagged = tree(sql) as Array<{ stmt: { IndexStmt: Record<string, unknown> } }>
		;(flagged[0] as { stmt: { IndexStmt: Record<string, unknown> } }).stmt.IndexStmt["concurrent"] = true
		expect(() => cutConcurrently(sql, flagged)).toThrow(/without CONCURRENTLY/)
	})
})

describe("replayStatements", () => {
	it("sends each statement as written, an index built CONCURRENTLY without it, and skips VACUUM and a bare CLUSTER", () => {
		const sql =
			"CREATE TABLE t (a int);\nCREATE INDEX CONCURRENTLY i ON t (a);\nVACUUM t;\nANALYZE t;\nCLUSTER;\nCLUSTER t USING i;"
		expect(replayStatements(file(sql)).map(({ sql: sent }) => sent)).toEqual([
			"CREATE TABLE t (a int)",
			"CREATE INDEX i ON t (a)",
			"ANALYZE t",
			"CLUSTER t USING i",
		])
	})

	/* P13 of r19: check's replay holds what a pending txmode-none file runs, as baseline's holds the history */
	it("sends a CONCURRENTLY detach without the keyword, and skips its FINALIZE and a REINDEX of a database or the system", () => {
		const sql =
			"ALTER TABLE ev DETACH PARTITION ev_old CONCURRENTLY;\nALTER TABLE ev DETACH PARTITION ev_old FINALIZE;\nALTER TABLE ev DETACH PARTITION ev_new;\nREINDEX DATABASE app;\nREINDEX SYSTEM;"
		expect(replayStatements(file(sql)).map(({ sql: sent }) => sent)).toEqual([
			"ALTER TABLE ev DETACH PARTITION ev_old ",
			"ALTER TABLE ev DETACH PARTITION ev_new",
		])
	})

	it("sends a REINDEX without options, and a statement the parser cannot read, as written, for dev to judge", () => {
		expect(replayStatements(file("REINDEX TABLE t;\nREINDEX TABLE CONCURRENTLY t;")).map(({ sql }) => sql)).toEqual([
			"REINDEX TABLE t",
			"REINDEX TABLE t",
		])
		expect(replayStatements(file("SELEC 1;")).map(({ sql }) => sql)).toEqual(["SELEC 1"])
		expect(makesCompared(file("SELEC 1;"))).toBe(false)
	})

	it.each([
		["ALTER SYSTEM SET work_mem = '4MB'", "ALTER SYSTEM runs only outside a transaction"],
		["CREATE DATABASE other", "CREATE DATABASE runs only outside a transaction"],
		["DROP TABLESPACE ts", "DROP TABLESPACE runs only outside a transaction"],
		["COMMIT", "baseline replays the history in one transaction of its own"],
		["BEGIN", "baseline replays the history in one transaction of its own"],
		["REINDEX (CONCURRENTLY) INDEX i", 'comb could not replay "REINDEX (CONCURRENTLY) INDEX i" without CONCURRENTLY'],
	])("stops on %j, naming it", (sql, said) => {
		expect(() => replayStatements(file(sql))).toThrow(said)
	})
})

/** A postgres.js stand-in: each query it was sent, answering `rows` to the catalog read and nothing else */
function fake(rows: Array<Record<string, unknown>> = [], fail?: (query: string) => Error | undefined) {
	const sent: Array<[string, unknown[]]> = []
	const given: Array<Record<string, unknown>> = []
	const connect = (options: Record<string, unknown>) => (
		given.push(options),
		{
			end: async () => undefined,
			unsafe: async (query: string, params: unknown[]) => {
				sent.push([query, params])
				const error = fail?.(query)
				if (error !== undefined) throw error
				return query === CATALOG ? rows : []
			},
		}
	)
	return { given, load: async () => connect, sent }
}

describe("replayCatalog", () => {
	it("replays in one transaction it rolls back, reading with the target's own query (the reviewer's addition B)", async () => {
		const dev = fake([{ name: "dev_user", what: "user" }])
		await replayCatalog(
			{ ...TARGET, schema: "app" },
			{ files: file("CREATE TABLE t (a int);"), targetUser: "app_user" },
			dev.load,
		)
		const target = fake([{ name: "app_user", what: "user" }])
		await readLiveObjects({ schema: "app", url: TARGET.url }, target.load)
		expect(dev.sent.map(([query]) => query)).toEqual([
			"BEGIN",
			'CREATE SCHEMA IF NOT EXISTS "app"',
			'SET LOCAL search_path TO "app"',
			"CREATE TABLE t (a int)",
			CATALOG,
			"ROLLBACK",
		])
		expect(dev.sent.find(([query]) => query === CATALOG)).toEqual(target.sent[0])
		/* one connection, so the transaction holds every statement, and dev's notices kept off the terminal */
		const [options] = dev.given as [{ max: number; onnotice: () => unknown }]
		expect([options.max, options.onnotice()]).toEqual([1, undefined])
	})

	it("names dev's role as the target's in a policy, so CURRENT_USER compares as each database was built (addition A)", async () => {
		const dev = fake([
			{ name: "dev_user", what: "user" },
			{ how: "for all, to dev_user, zeta, permissive", name: "p", on_table: "t", what: "policy" },
			{ how: "for all, to alpha, public, restrictive", name: "q", on_table: "t", what: "policy" },
		])
		const live = await replayCatalog(TARGET, { files: file("SELECT 1;"), targetUser: "app_user" }, dev.load)
		expect(live.user).toBe("app_user")
		expect([...(live.policies.get("t") ?? [])]).toEqual([
			["p", "for all, to app_user, zeta, permissive"],
			["q", "for all, to alpha, public, restrictive"],
		])
		const same = await replayCatalog(
			TARGET,
			{ files: file("SELECT 1;"), targetUser: "dev_user" },
			fake([{ name: "dev_user", what: "user" }]).load,
		)
		expect(same.user).toBe("dev_user")
	})
})

describe("replayCatalog on what dev refuses", () => {
	it("refuses a statement dev refuses, naming the file, the statement and dev's error, and still rolls back", async () => {
		const dev = fake([], (query) =>
			query.startsWith("CREATE VIEW") ? new Error('column "nope" does not exist') : undefined,
		)
		const replay = replayCatalog(
			TARGET,
			{ files: file("CREATE TABLE t (a int);\nCREATE VIEW v AS SELECT nope FROM t;"), targetUser: "u" },
			dev.load,
		)
		await expect(replay).rejects.toThrow(
			'1_a.sql: devUrl refused "CREATE VIEW v AS SELECT nope FROM t" as baseline replayed the history there: column "nope" does not exist; baseline compares nothing',
		)
		await expect(replay).rejects.toBeInstanceOf(ReplayFailed)
		expect(dev.sent.at(-1)?.[0]).toBe("ROLLBACK")
	})

	it("says comb could not replay when dev itself fails, never naming its password", async () => {
		const dev = fake([], (query) =>
			query === "BEGIN" ? new Error("password authentication failed for postgres://u:hunter2@dev/dev") : undefined,
		)
		const secret = { ...TARGET, devUrl: "postgres://u:hunter2@dev/dev" }
		const replay = replayCatalog(secret, { files: file("SELECT 1;"), targetUser: "u" }, dev.load)
		await expect(replay).rejects.toThrow(/^comb could not replay the history on devUrl: /)
		await expect(replay).rejects.not.toThrow(/hunter2/)
	})
})
