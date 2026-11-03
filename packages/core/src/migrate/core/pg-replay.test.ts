import { beforeAll, describe, expect, it } from "vitest"
import { readLiveObjects } from "./pg-live-objects.ts"
import { CATALOG } from "./pg-live-catalog.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { replayCatalog } from "./pg-replay.ts"
import { ReplayFailed } from "./replay-failed.ts"

beforeAll(loadPostgresParser)

const file = (sql: string) => [{ name: "1_a.sql", sql }]
const TARGET = { devUrl: "postgres://dev/dev", lockTimeout: "5s", schema: "public", url: "postgres://app/app" }

/* the replay's database, named for the run's start and a random suffix */
const DATABASE = /comb_replay_\d{13}_[0-9a-f]{8}/g

/* the server's counts: whether it keeps them, and a transaction's writes to the shared catalogs */
const COUNTED = "SELECT current_setting('track_counts') AS on"
const WRITES = expect.stringMatching(/^SELECT s\.relname, s\.n_tup_ins/)

/** A postgres.js stand-in on every connection: each query it was sent, the replay's database as <db>, answering `rows` to the catalog read */
function fake(rows: Array<Record<string, unknown>> = [], fail?: (query: string) => Error | undefined) {
	const sent: Array<[string, unknown[]]> = []
	const given: Array<Record<string, unknown>> = []
	const connect = (options: Record<string, unknown>) => (
		given.push(options),
		{
			end: async () => undefined,
			unsafe: async (query: string, params: unknown[]) => {
				sent.push([query.replaceAll(DATABASE, "<db>"), params])
				const error = fail?.(query)
				if (error !== undefined) throw error
				if (query === COUNTED) return [{ on: "on" }]
				return query === CATALOG ? rows : []
			},
		}
	)
	return { given, load: async () => connect, queries: () => sent.map(([query]) => query), sent }
}

/* what every replay sends before and after the history: the sweep, its database made and copied into, and dropped */
const SWEEP = [expect.stringMatching(/^SELECT datname FROM pg_database/), expect.stringMatching(/^SELECT r\.rolname/)]
const MADE = ["CREATE DATABASE <db> TEMPLATE template0", COUNTED, expect.stringMatching(/^SELECT e\.extname/)]
const DROPPED = "DROP DATABASE IF EXISTS <db>"

describe("replayCatalog", () => {
	it("replays each file in a transaction of its own in a database of its own, reading with the target's own query (addition B)", async () => {
		const dev = fake([{ name: "dev_user", what: "user" }])
		await replayCatalog(
			{ ...TARGET, schema: "app" },
			{
				files: [
					{ name: "1_a.sql", sql: "CREATE TABLE t (a int);\nALTER SYSTEM SET work_mem = '4MB';" },
					{ name: "2_b.sql", sql: "-- atlas:txmode none\n\nCREATE INDEX CONCURRENTLY i ON t (a);" },
				],
				targetUser: "app_user",
			},
			dev.load,
		)
		const target = fake([{ name: "app_user", what: "user" }])
		await readLiveObjects({ schema: "app", url: TARGET.url }, target.load)
		expect(dev.queries()).toEqual([
			...SWEEP,
			...MADE,
			'CREATE SCHEMA IF NOT EXISTS "app"',
			'SET search_path TO "app"',
			"BEGIN",
			WRITES,
			"CREATE TABLE t (a int)",
			WRITES,
			"COMMIT",
			"CREATE INDEX CONCURRENTLY i ON t (a)",
			CATALOG,
			DROPPED,
		])
		expect(dev.sent.find(([query]) => query === CATALOG)).toEqual(target.sent[0])
		/* one connection each, to devUrl's database and then to the replay's, dev's notices kept off the terminal */
		const [admin, replay] = dev.given as [
			{ database: string; max: number; onnotice: () => unknown },
			{ database: string },
		]
		expect([admin.max, admin.onnotice(), admin.database]).toEqual([1, undefined, "dev"])
		expect(replay.database).toMatch(/^comb_replay_\d{13}_[0-9a-f]{8}$/)
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
	it("refuses a statement dev refuses, naming the file, the statement and dev's error, and still drops its database", async () => {
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
		expect(dev.sent.at(-1)?.[0]).toBe(DROPPED)
	})

	it("sends a statement comb's parser cannot read as written, for dev to refuse", async () => {
		const dev = fake([], (query) =>
			query.startsWith("SELEC ") ? new Error('syntax error at or near "SELEC"') : undefined,
		)
		const replay = replayCatalog(TARGET, { files: file("SELEC 1;"), targetUser: "u" }, dev.load)
		await expect(replay).rejects.toThrow('1_a.sql: devUrl refused "SELEC 1" as baseline replayed the history there')
	})

	it("keeps the refusal when cleaning up fails, and still tries every cleanup step (R2 of the P1 review)", async () => {
		const dev = fake([], (query) =>
			query.startsWith("CREATE VIEW") || query.startsWith("DROP DATABASE")
				? new Error("database is being accessed by other users")
				: undefined,
		)
		const replay = replayCatalog(
			TARGET,
			{ files: file("CREATE ROLE r;\nCREATE VIEW v AS SELECT nope;"), targetUser: "u" },
			dev.load,
		)
		await expect(replay).rejects.toThrow(
			/^1_a\.sql: devUrl refused "CREATE VIEW v AS SELECT nope" as baseline replayed/,
		)
		expect(dev.queries().slice(-2)).toEqual([DROPPED, 'DROP ROLE IF EXISTS "r"'])
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

/* P5 of r20: a password that is a word of comb's own hint masks the driver's text only */
describe("replayCatalog on a devUrl password comb's hint also says", () => {
	it("masks a password in what dev said, never in comb's own words", async () => {
		const tls = "Client network socket disconnected before secure TLS connection was established for comb@dev"
		const hint =
			"the server takes no TLS, which comb and Atlas require where devUrl names no sslmode; set sslmode=disable on devUrl for a server without TLS"
		const secret = { ...TARGET, devUrl: "postgres://u:comb@dev/dev" }
		const failing = (at: string) => fake([], (query) => (query.startsWith(at) ? new Error(tls) : undefined)).load
		await expect(
			replayCatalog(secret, { files: file("SELECT 1;"), targetUser: "u" }, failing("SELECT datname")),
		).rejects.toThrow(
			`comb could not replay the history on devUrl: Client network socket disconnected before secure TLS connection was established for ***@dev: ${hint}`,
		)
		await expect(
			replayCatalog(secret, { files: file("CREATE TABLE t (a int);"), targetUser: "u" }, failing("CREATE TABLE")),
		).rejects.toThrow(`for ***@dev: ${hint}; baseline compares nothing`)
	})
})

/* P2 of r19, the replay's sibling: a devUrl pgUrlProblems refuses never reaches a connection */
describe("replayCatalog on a devUrl comb refuses", () => {
	it.each([
		[TARGET.url, "url and devUrl are the same database; Atlas empties the dev database, so give it its own"],
		[
			"postgres://dev/dev?sslmode=verify-ca&sslrootcert=/nonexistent/root.crt",
			"devUrl's sslrootcert /nonexistent/root.crt cannot be read",
		],
	])("refuses %s before connecting", async (devUrl, said) => {
		const dev = fake([])
		const replay = replayCatalog({ ...TARGET, devUrl }, { files: file("SELECT 1;"), targetUser: "u" }, dev.load)
		await expect(replay).rejects.toThrow(said)
		expect(dev.given).toEqual([])
	})
})

/* P1 of r20: the replay's own database needs CREATEDB, and holds devUrl's extensions */
describe("replayCatalog's database", () => {
	const denied = Object.assign(new Error("permission denied to create database"), { code: "42501" })

	it("refuses a role without CREATEDB, naming the privilege, and makes nothing", async () => {
		const dev = fake([], (query) => (query.startsWith("CREATE DATABASE") ? denied : undefined))
		const replay = replayCatalog(TARGET, { files: file("SELECT 1;"), targetUser: "u" }, dev.load)
		await expect(replay).rejects.toThrow(
			/^devUrl's role cannot create a database \(CREATEDB\).*; baseline compares nothing$/,
		)
		await expect(replay).rejects.toBeInstanceOf(ReplayFailed)
		expect(dev.queries().at(-1)).toBe("CREATE DATABASE <db> TEMPLATE template0")
	})

	it("says comb could not replay when making the database fails for another reason", async () => {
		const full = Object.assign(new Error("could not write to file"), { code: "53100" })
		const dev = fake([], (query) => (query.startsWith("CREATE DATABASE") ? full : undefined))
		await expect(replayCatalog(TARGET, { files: file("SELECT 1;"), targetUser: "u" }, dev.load)).rejects.toThrow(
			"comb could not replay the history on devUrl: could not write to file",
		)
	})
})
