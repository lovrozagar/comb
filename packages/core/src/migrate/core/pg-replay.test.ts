import { beforeAll, describe, expect, it, vi } from "vitest"
import { stopsEnded } from "./cleanup.ts"
import { readLiveObjects } from "./pg-live-objects.ts"
import { CATALOG } from "./pg-live-catalog.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { replayCatalog } from "./pg-replay.ts"
import { ReplayFailed } from "./replay-failed.ts"

beforeAll(loadPostgresParser)

const file = (sql: string) => [{ name: "1_a.sql", sql }]
/* what a replay prints, where a test reads none of it */
const QUIET = (): undefined => undefined
/* a replay no Atlas reads, saying nothing */
const UNREAD = { inspect: async (): Promise<undefined> => undefined, print: QUIET }
const TARGET = { devUrl: "postgres://dev/dev", lockTimeout: "5s", schema: "public", url: "postgres://app/app" }

/* the replay's database, named for the backend that made it and a random suffix */
const DATABASE = /comb_replay_\d+_\d+_[0-9a-f]{8}/g

/* the target database's locale, which the replay's database is made at */
const LIBC = { collate: "C", ctype: "C", encoding: "UTF8", locale: null, provider: "c", rules: null }

/* the backend a replay runs on, which names its database and tags its roles */
const OWNER = [{ pid: 7, start: "9", version: 170000 }]

/* the server's counts: whether it keeps them, and a transaction's writes to the shared catalogs */
const COUNTS = "SELECT current_setting('track_counts') AS on, coalesce("
const COUNTED = expect.stringMatching(/^SELECT current_setting\('track_counts'\) AS on, coalesce\(/)

/** What a replayed transaction of `statements` sends: its counts read at BEGIN and again before COMMIT */
/* the server's shared catalogs read as committed, around every file and bare statement (P1 and P2 of r22) */
const SNAPSHOT = "EXECUTE comb_snapshot"
/* the read prepared on the connection that makes it, once */
const PREPARE = expect.stringMatching(/^PREPARE comb_snapshot AS SELECT 'membership' AS noun, .* UNION ALL /)
const inTransaction = (...statements: unknown[]) => ["BEGIN", COUNTED, ...statements, COUNTED, SNAPSHOT, "COMMIT"]

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
				if (query.startsWith(COUNTS)) return [{ on: "on", writes: {} }]
				if (query.endsWith("WHERE pid = pg_backend_pid()")) return OWNER
				if (query.endsWith("WHERE d.datname = current_database()")) return [LIBC]
				/* every role the replay made carries its tag, so its cleanup drops each */
				if (query.startsWith("SELECT 1 FROM pg_roles r JOIN pg_shdescription")) return [{ "?column?": 1 }]
				return query === CATALOG ? rows : []
			},
		}
	)
	return { given, load: async () => connect, queries: () => sent.map(([query]) => query), sent }
}

/* what every replay sends before and after the history: the sweep, its database made and copied into, and dropped */
const SESSIONS = expect.stringMatching(/^SELECT pid, datname, .* FROM pg_stat_activity$/)
const SWEEP = [
	SESSIONS,
	expect.stringMatching(/^SELECT datname, datistemplate FROM pg_database/),
	expect.stringMatching(/^SELECT r\.rolname/),
	expect.stringMatching(/^SELECT pid, .* WHERE pid = pg_backend_pid\(\)$/),
	"SELECT set_config($1, $2, false), set_config($3, $4, false)",
]
const MADE = [
	expect.stringMatching(
		/^SELECT pg_encoding_to_char\(d\.encoding\) AS encoding, .* WHERE d\.datname = current_database\(\)$/,
	),
	"CREATE DATABASE <db> TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' LOCALE_PROVIDER libc",
	"SELECT rolname, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user",
	COUNTED,
	expect.stringMatching(/^SELECT e\.extname/),
]
const DROPPED = "DROP DATABASE IF EXISTS <db> WITH (FORCE)"
const UNTEMPLATED = "ALTER DATABASE <db> IS_TEMPLATE false"
/* the replay's connection closed, and any backend still in its database ended, before the drop */
const ENDED = expect.stringMatching(/^SELECT pg_terminate_backend\(pid\)/)
/* then the read of the subscriptions and slots in it, which Postgres drops no database holding */
const HELD = expect.stringMatching(/^SELECT coalesce\(\(SELECT array_agg\(s\.subname/)

/** Postgres's refusal of a statement starting `start` in a block, once: the guarded try rolls back and it runs bare */
function refusedInBlockOnce(start: string): (query: string) => Error | undefined {
	const tries = { block: 0 }
	return (query) =>
		query.startsWith(start) && tries.block++ === 0
			? Object.assign(new Error(`${start} cannot run inside a transaction block`), { code: "25001" })
			: undefined
}

describe("replayCatalog's inspect", () => {
	/* 16.3 (b) of plan 21: Atlas compares the target with what the replay left, while its adopted roles are still dropped after */
	it("has `inspect` read the replay's database by its name before the cleanup drops it, and hands back what it read", async () => {
		const dev = fake([{ name: "dev_user", what: "user" }])
		const inspected: Array<{ database: string; dropped: boolean }> = []
		const inspect = async (database: string) => {
			inspected.push({ database, dropped: dev.queries().includes(DROPPED) })
			return "read"
		}
		const replayed = await replayCatalog(
			TARGET,
			{ files: file("CREATE TABLE t (a int);"), inspect, print: QUIET, targetUser: "u" },
			dev.load,
		)
		expect([replayed.inspected, inspected]).toEqual([
			"read",
			[{ database: expect.stringMatching(new RegExp(`^${DATABASE.source}$`)), dropped: false }],
		])
		expect(dev.queries()).toContain(DROPPED)
	})
})

describe("replayCatalog", () => {
	it("replays each file in a transaction of its own in a database of its own, reading with the target's own query (addition B)", async () => {
		const dev = fake([{ name: "dev_user", what: "user" }], refusedInBlockOnce("CREATE INDEX CONCURRENTLY"))
		await replayCatalog(
			{ ...TARGET, schema: "app" },
			{
				files: [
					{ name: "1_a.sql", sql: "CREATE TABLE t (a int);\nALTER SYSTEM SET work_mem = '4MB';" },
					{ name: "2_b.sql", sql: "-- atlas:txmode none\n\nCREATE INDEX CONCURRENTLY i ON t (a);" },
				],
				...UNREAD,
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
			PREPARE,
			SNAPSHOT,
			...inTransaction("CREATE TABLE t (a int)"),
			"BEGIN",
			COUNTED,
			"CREATE INDEX CONCURRENTLY i ON t (a)",
			"ROLLBACK",
			"CREATE INDEX CONCURRENTLY i ON t (a)",
			SNAPSHOT,
			CATALOG,
			ENDED,
			HELD,
			UNTEMPLATED,
			DROPPED,
		])
		expect(dev.sent.find(([query]) => query === CATALOG)).toEqual(target.sent[0])
		/* one connection each, to devUrl's database, to url's for its locale and then to the replay's, notices kept off the terminal */
		const [admin, url, replay] = dev.given as [
			{ database: string; max: number; onnotice: () => unknown },
			{ database: string; max: number; onnotice: () => unknown },
			{ connection: Record<string, string>; database: string },
		]
		expect([admin.max, admin.onnotice(), admin.database]).toEqual([1, undefined, "dev"])
		expect([url.max, url.onnotice(), url.database]).toEqual([1, undefined, "app"])
		expect(replay.database).toMatch(/^comb_replay_7_9_[0-9a-f]{8}$/)
		/* the replay's connection names its owner, by which a sweep finds the statement a killed run left (P4 of r22) */
		expect(replay.connection).toMatchObject({
			application_name: "comb_replay 7_9",
			client_connection_check_interval: "1s",
		})
		/* the prepare's session, then one for each file, as apply gives each an Atlas call (PA1 of r22b), each searching the schema and reading dates month first from its start, as Atlas's session does (PR3 of r22b) */
		const sessions = dev.given.slice(2) as Array<{ connection: Record<string, string>; database: string }>
		expect(
			sessions.map((each) => [each.database, each.connection["search_path"], each.connection["DateStyle"]]),
		).toEqual(Array.from({ length: 3 }, () => [replay.database, "app", "ISO, MDY"]))
	})
})

describe("replayCatalog of a policy", () => {
	it("names dev's role as the target's in a policy, so CURRENT_USER compares as each database was built (addition A)", async () => {
		const dev = fake([
			{ name: "dev_user", what: "user" },
			{ how: "for all, to dev_user, zeta, permissive", name: "p", on_table: "t", what: "policy" },
			{ how: "for all, to alpha, public, restrictive", name: "q", on_table: "t", what: "policy" },
		])
		const live = await replayCatalog(TARGET, { files: file("SELECT 1;"), ...UNREAD, targetUser: "app_user" }, dev.load)
		expect(live.catalog.user).toBe("app_user")
		expect([...(live.catalog.policies.get("t") ?? [])]).toEqual([
			["p", "for all, to app_user, zeta, permissive"],
			["q", "for all, to alpha, public, restrictive"],
		])
		const same = await replayCatalog(
			TARGET,
			{ files: file("SELECT 1;"), ...UNREAD, targetUser: "dev_user" },
			fake([{ name: "dev_user", what: "user" }]).load,
		)
		expect(same.catalog.user).toBe("dev_user")
	})
})

describe("replayCatalog on what dev refuses", () => {
	it("refuses a statement dev refuses, naming the file, the statement and dev's error, and still drops its database", async () => {
		const dev = fake([], (query) =>
			query.startsWith("CREATE VIEW") ? new Error('column "nope" does not exist') : undefined,
		)
		const replay = replayCatalog(
			TARGET,
			{ files: file("CREATE TABLE t (a int);\nCREATE VIEW v AS SELECT nope FROM t;"), ...UNREAD, targetUser: "u" },
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
		const replay = replayCatalog(TARGET, { files: file("SELEC 1;"), ...UNREAD, targetUser: "u" }, dev.load)
		await expect(replay).rejects.toThrow('1_a.sql: devUrl refused "SELEC 1" as baseline replayed the history there')
	})
})

describe("replayCatalog on a dev that fails past a refusal", () => {
	it("keeps the refusal when cleaning up fails, still tries every cleanup step (R2 of the P1 review), and says what it left", async () => {
		const dev = fake([], (query) =>
			query.startsWith("CREATE VIEW") || query.startsWith("DROP")
				? Object.assign(new Error("database is being accessed by other users"), { code: "55006" })
				: undefined,
		)
		const said: string[] = []
		const replay = replayCatalog(
			TARGET,
			{
				files: file("CREATE ROLE r;\nCREATE VIEW v AS SELECT nope;"),
				inspect: UNREAD.inspect,
				print: (line) => said.push(line.replaceAll(DATABASE, "<db>")),
				targetUser: "u",
			},
			dev.load,
		)
		await expect(replay).rejects.toThrow(
			/^1_a\.sql: devUrl refused "CREATE VIEW v AS SELECT nope" as baseline replayed/,
		)
		expect(dev.queries().slice(-4)).toEqual([
			DROPPED,
			expect.stringMatching(/^SELECT 1 FROM pg_roles r JOIN pg_shdescription .* LIKE 'comb\\_replay %'$/),
			'DROP ROLE IF EXISTS "r"',
			"SELECT 1 FROM pg_roles WHERE rolname = $1",
		])
		const left =
			"which a replay left on devUrl's server: database is being accessed by other users; the next check or apply that reaches that server drops it"
		/* the role reads as gone after its drop failed, so as dropped */
		expect(said).toEqual([`comb could not drop database <db>, ${left}`])
	})

	it("says comb could not replay when dev itself fails, never naming its password", async () => {
		const dev = fake([], (query) =>
			query === "BEGIN" ? new Error("password authentication failed for postgres://u:hunter2@dev/dev") : undefined,
		)
		const secret = { ...TARGET, devUrl: "postgres://u:hunter2@dev/dev" }
		const replay = replayCatalog(secret, { files: file("SELECT 1;"), ...UNREAD, targetUser: "u" }, dev.load)
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
			replayCatalog(secret, { files: file("SELECT 1;"), ...UNREAD, targetUser: "u" }, failing("SELECT datname")),
		).rejects.toThrow(
			`comb could not replay the history on devUrl: Client network socket disconnected before secure TLS connection was established for ***@dev: ${hint}`,
		)
		await expect(
			replayCatalog(
				secret,
				{ files: file("CREATE TABLE t (a int);"), ...UNREAD, targetUser: "u" },
				failing("CREATE TABLE"),
			),
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
		const replay = replayCatalog(
			{ ...TARGET, devUrl },
			{ files: file("SELECT 1;"), ...UNREAD, targetUser: "u" },
			dev.load,
		)
		await expect(replay).rejects.toThrow(said)
		expect(dev.given).toEqual([])
	})
})

/* P1 of r20: the replay's own database needs CREATEDB, and holds devUrl's extensions */
describe("replayCatalog's database", () => {
	const denied = Object.assign(new Error("permission denied to create database"), { code: "42501" })

	it("refuses a role without CREATEDB, naming the privilege, and makes nothing", async () => {
		const dev = fake([], (query) => (query.startsWith("CREATE DATABASE") ? denied : undefined))
		const replay = replayCatalog(TARGET, { files: file("SELECT 1;"), ...UNREAD, targetUser: "u" }, dev.load)
		await expect(replay).rejects.toThrow(
			/^devUrl's role cannot create a database \(CREATEDB\).*; baseline compares nothing$/,
		)
		await expect(replay).rejects.toBeInstanceOf(ReplayFailed)
		expect(dev.queries().at(-1)).toMatch(/^CREATE DATABASE <db> TEMPLATE template0 /)
	})

	it("refuses a locale devUrl's server cannot make, naming it and the server's error (PR4 of r22b)", async () => {
		const lacking = Object.assign(new Error('invalid LC_COLLATE locale name: "C"'), { code: "42809" })
		const dev = fake([], (query) => (query.startsWith("CREATE DATABASE") ? lacking : undefined))
		const replay = replayCatalog(TARGET, { files: file("SELECT 1;"), ...UNREAD, targetUser: "u" }, dev.load)
		await expect(replay).rejects.toThrow(
			`devUrl's server could not make the replay's database at the target database's locale (ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' LOCALE_PROVIDER libc), and a verdict under another is not the target's; point devUrl at a server that has it: invalid LC_COLLATE locale name: "C"; baseline compares nothing`,
		)
		await expect(replay).rejects.toBeInstanceOf(ReplayFailed)
	})
})

/** `body` run with the host's own `signal` listeners off, `host` listening instead when given, and process.kill stubbed */
async function signalled(signal: NodeJS.Signals, host: (() => void) | undefined, body: () => Promise<void>) {
	const listeners = process.listeners(signal)
	process.removeAllListeners(signal)
	if (host !== undefined) process.on(signal, host)
	const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
	try {
		await body()
		/* the handler's kill follows its cleanup, a turn after the replay's own */
		await new Promise((done) => setImmediate(done))
		return kill.mock.calls
	} finally {
		await stopsEnded()
		kill.mockRestore()
		process.removeAllListeners(signal)
		for (const listener of listeners) process.on(signal, listener)
	}
}

/* P2 of r21: a check stopped mid-replay cleans up once, then ends by the signal; the child-process cases are tests/integration/postgres/replay-sweep.test.ts */
describe("replayCatalog stopped by a signal", () => {
	it.each([["SIGINT"], ["SIGTERM"]] as const)("cleans up once on %s, then ends by it again", async (signal) => {
		const dev = fake([], (query) => {
			if (query.startsWith("CREATE TABLE")) process.emit(signal, signal)
			return undefined
		})
		const killed = await signalled(signal, undefined, () =>
			replayCatalog(TARGET, { files: file("CREATE TABLE t (a int);"), ...UNREAD, targetUser: "u" }, dev.load).then(
				() => undefined,
			),
		)
		expect(killed).toEqual([[process.pid, signal]])
		expect(dev.queries().filter((query) => query === DROPPED)).toHaveLength(1)
	})

	it("leaves the end to a host that listens for the signal itself", async () => {
		let heard = 0
		const dev = fake([], (query) => {
			if (query.startsWith("CREATE TABLE")) process.emit("SIGTERM", "SIGTERM")
			return undefined
		})
		const killed = await signalled(
			"SIGTERM",
			() => void heard++,
			() =>
				replayCatalog(TARGET, { files: file("CREATE TABLE t (a int);"), ...UNREAD, targetUser: "u" }, dev.load).then(
					() => undefined,
				),
		)
		expect([killed, heard]).toEqual([[], 1])
		expect(dev.queries().filter((query) => query === DROPPED)).toHaveLength(1)
	})

	it("drops the database a replay made after a signal that came before it, the host keeping the process", async () => {
		const dev = fake([], (query) => {
			if (query.startsWith("SELECT datname, datistemplate FROM pg_database")) process.emit("SIGINT", "SIGINT")
			return undefined
		})
		const killed = await signalled(
			"SIGINT",
			() => undefined,
			() =>
				replayCatalog(TARGET, { files: file("SELECT 1;"), ...UNREAD, targetUser: "u" }, dev.load).then(() => undefined),
		)
		expect(killed).toEqual([])
		expect(dev.queries().filter((query) => query === DROPPED)).toHaveLength(1)
	})
})
