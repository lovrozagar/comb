import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { replayPending, throughPending } from "./pg-check-replay.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { ReplayFailed } from "./replay-failed.ts"

beforeAll(loadPostgresParser)

const TARGET = { devUrl: "postgres://dev/dev", lockTimeout: "5s", schema: "public", url: "postgres://app/app" }
const file = (sql: string) => ({ files: [{ name: "1_a.sql", sql }], pending: ["1_a.sql"] })

/* the replay's database, named for the backend that made it and a random suffix */
const DATABASE = /comb_replay_\d+_\d+_[0-9a-f]{8}/g

/* the backend a replay runs on, which names its database and tags its roles */
const OWNER = [{ pid: 7, start: "9" }]

/* the server's counts: whether it keeps them, and a transaction's writes to the shared catalogs */
const COUNTED = "SELECT current_setting('track_counts') AS on"
const WRITES = expect.stringMatching(/^SELECT s\.relname, s\.n_tup_ins/)

/** What a replayed transaction of `statements` sends: its counts read at BEGIN and again before COMMIT */
const inTransaction = (...statements: unknown[]) => ["BEGIN", WRITES, ...statements, COUNTED, WRITES, "COMMIT"]

/* what every replay sends before and after the history: the sweep, its database made and copied into, and dropped */
const AROUND = {
	after: [expect.stringMatching(/^SELECT pg_terminate_backend\(pid\)/), "DROP DATABASE IF EXISTS <db>"],
	before: [
		expect.stringMatching(/^SELECT pid, datname, .* FROM pg_stat_activity$/),
		expect.stringMatching(/^SELECT datname FROM pg_database/),
		expect.stringMatching(/^SELECT r\.rolname/),
		expect.stringMatching(/^SELECT pid, .* WHERE pid = pg_backend_pid\(\)$/),
		"CREATE DATABASE <db> TEMPLATE template0",
		COUNTED,
		expect.stringMatching(/^SELECT e\.extname/),
		'SET search_path TO "public"',
	],
}

/* the target's roles, read for those the pending files make, a replay's own left out */
const ROLES = /^SELECT r\.rolname FROM pg_roles r LEFT JOIN pg_shdescription d .* NOT LIKE 'comb\\_replay %'\)$/
const readsRoles = (sent: readonly string[]) => sent.some((query) => ROLES.test(query))

/**
 * A postgres.js stand-in on every connection: each query it was sent, the replay's database as <db>,
 * failing those `fail` names; the server holds the `roles`
 */
function fake(fail?: (query: string) => Error | undefined, roles: readonly string[] = []) {
	const sent: string[] = []
	const connect = () => ({
		end: async () => undefined,
		unsafe: async (query: string, params: unknown[]) => {
			sent.push(query.replaceAll(DATABASE, "<db>"))
			const error = fail?.(query)
			if (error !== undefined) throw error
			if (ROLES.test(query))
				return roles.filter((role) => (params[0] as string[]).includes(role)).map((rolname) => ({ rolname }))
			if (query.endsWith("WHERE pid = pg_backend_pid()")) return OWNER
			return query === COUNTED ? [{ on: "on" }] : []
		},
	})
	return { load: async () => connect, sent }
}

/** A load of postgres.js where it is not installed */
const noPeer = async (): Promise<never> => {
	throw new Error(
		`comb needs postgres (>=3.4.9 <4) to replay the history and the pending files on devUrl in a check; install "postgres@>=3.4.9 <4"`,
	)
}

/** What `replayPending` printed for `sql` on `devUrl`, and the queries dev was sent */
async function replayed(sql: string, more: { devUrl?: string; load?: () => Promise<never> } = {}) {
	const out: string[] = []
	const dev = fake()
	const target = { ...TARGET, devUrl: more.devUrl ?? TARGET.devUrl }
	await replayPending({ print: (line) => out.push(line), target }, file(sql), more.load ?? dev.load)
	return { out, sent: dev.sent }
}

describe("replayPending (P13 of r19)", () => {
	it("replays each file in a transaction of its own in a database of its own, printing nothing", async () => {
		expect(await replayed("CREATE TABLE t (a int);")).toEqual({
			out: [],
			sent: [...AROUND.before, ...inTransaction("CREATE TABLE t (a int)"), ...AROUND.after],
		})
	})

	it("says it replayed nothing on Atlas's own docker:// container, and connects to nothing", async () => {
		const { out, sent } = await replayed("CREATE TABLE t (a int);", { devUrl: "docker://postgres/17/dev" })
		expect(out).toEqual([
			"Check did not replay the pending files on devUrl: docker://postgres/17/dev is Atlas's own container, which comb cannot reach, so a statement Postgres refuses on every database is found only when it applies; set devUrl to a postgres:// scratch database comb can connect to",
		])
		expect(sent).toEqual([])
	})

	it("says it replayed nothing on a docker:// devUrl without the postgres package, for the container's reason", async () => {
		const { out } = await replayed("CREATE TABLE t (a int);", { devUrl: "docker://postgres/17/dev", load: noPeer })
		expect(out).toEqual([
			expect.stringMatching(
				/^Check did not replay the pending files on devUrl: docker:\/\/postgres\/17\/dev is Atlas's own container/,
			),
		])
	})

	it("says it replayed nothing without the postgres package, naming why", async () => {
		const { out } = await replayed("CREATE TABLE t (a int);", { load: noPeer })
		expect(out).toEqual([
			`Check did not replay the pending files on devUrl: comb needs postgres (>=3.4.9 <4) to replay the history and the pending files on devUrl in a check; install "postgres@>=3.4.9 <4"`,
		])
	})

	it("leaves out each statement whose scope is the server or another database, naming it, and replays the rest", async () => {
		const { out, sent } = await replayed(
			"CREATE TABLE t (a int);\nALTER SYSTEM SET work_mem = '4MB';\nALTER DATABASE app SET work_mem = '4MB';",
		)
		expect(out).toEqual([
			"Check left \"ALTER SYSTEM SET work_mem = '4MB'\" in 1_a.sql out of its replay on devUrl: ALTER SYSTEM reaches past the database the replay runs in, so apply alone runs it",
			expect.stringMatching(
				/^Check left "ALTER DATABASE app SET work_mem = '4MB'" in 1_a\.sql out of its replay on devUrl: /,
			),
		])
		expect(sent).toEqual([...AROUND.before, ...inTransaction("CREATE TABLE t (a int)"), ...AROUND.after])
	})

	it("refuses a statement dev refuses, naming the file, the statement and Postgres's message", async () => {
		const dev = fake((query) =>
			query.startsWith("ALTER TABLE") ? new Error("cannot alter type of a column used by a view or rule") : undefined,
		)
		const replay = replayPending(
			{ print: () => undefined, target: TARGET },
			file("ALTER TABLE t ALTER COLUMN v TYPE text;"),
			dev.load,
		)
		await expect(replay).rejects.toThrow(
			'1_a.sql: devUrl refused "ALTER TABLE t ALTER COLUMN v TYPE text" as check replayed the history and the pending files there: cannot alter type of a column used by a view or rule; check applies nothing',
		)
		await expect(replay).rejects.toBeInstanceOf(ReplayFailed)
	})
})

/* P7 of r21: the replay uses a role the server holds, so a pending CREATE ROLE of one passed check, and apply stopped at it.
   The history made `kept`; the pending file is 2_b.sql */
const history = { name: "1_a.sql", sql: "CREATE ROLE kept;" }
const twoFiles = (sql: string) => ({ files: [history, { name: "2_b.sql", sql }], pending: ["2_b.sql"] })

/** What `replayPending` did with `sql` pending after a history that made `kept`: why it refused, and the queries sent */
async function held(sql: string, roles: readonly string[], devUrl = TARGET.devUrl) {
	const dev = fake(undefined, roles)
	const out: string[] = []
	const target = { ...TARGET, devUrl }
	const refused = await replayPending({ print: (line) => out.push(line), target }, twoFiles(sql), dev.load).then(
		() => undefined,
		(error: Error) => error,
	)
	return { out, refused, sent: dev.sent }
}

describe("replayPending of a pending file that makes a role", () => {
	it("refuses a role the target's server holds, as Postgres says it, naming the file apply would stop at, and replays nothing", async () => {
		/* a statement comb's parser cannot read is Postgres's to refuse, and hides no role after it */
		const { refused, sent } = await held("CREATE TABLE t (a int);\nSELEC 1;\nCREATE ROLE reader;", ["reader"])
		expect(refused).toEqual(new ReplayFailed('role "reader" already exists; apply would stop at 2_b.sql'))
		expect(refused).toBeInstanceOf(ReplayFailed)
		expect(sent).toEqual([expect.stringMatching(ROLES)])
	})

	it("refuses the role apply reaches first, a rename to one included", async () => {
		const { refused } = await held('ALTER ROLE "old" RENAME TO "Writer";\nCREATE USER reader;', ["reader", "Writer"])
		expect(refused).toEqual(new ReplayFailed('role "Writer" already exists; apply would stop at 2_b.sql'))
	})

	it("reads no role for a history's CREATE ROLE, and replays the role a file drops first and makes anew", async () => {
		const { refused, sent } = await held("DROP ROLE IF EXISTS kept, reader;\nCREATE ROLE reader;", ["kept", "reader"])
		expect(refused).toBeUndefined()
		expect(readsRoles(sent)).toBe(false)
		const unmade = await held("CREATE TABLE t (a int);", ["kept"])
		expect(unmade.refused).toBeUndefined()
		expect(readsRoles(unmade.sent)).toBe(false)
	})

	it("passes a role the server does not hold, and replays the files", async () => {
		const { refused, sent } = await held("CREATE ROLE reader;", [])
		expect(refused).toBeUndefined()
		expect(sent.slice(0, 2)).toEqual([expect.stringMatching(ROLES), AROUND.before[0]])
	})

	it("reads the roles on a docker:// devUrl too, which it replays nothing on", async () => {
		const refused = await held("CREATE ROLE reader;", ["reader"], "docker://postgres/17/dev")
		expect(refused.refused).toEqual(new ReplayFailed('role "reader" already exists; apply would stop at 2_b.sql'))
		const passed = await held("CREATE ROLE reader;", [], "docker://postgres/17/dev")
		expect(passed.out).toEqual([expect.stringMatching(/^Check did not replay the pending files on devUrl: docker:/)])
		expect(passed.sent).toEqual([expect.stringMatching(ROLES)])
	})

	it("refuses when it cannot read the target's roles, naming url and the error", async () => {
		const dev = fake((query) => (ROLES.test(query) ? new Error("permission denied for view pg_roles") : undefined))
		const replay = replayPending({ print: () => undefined, target: TARGET }, twoFiles("CREATE ROLE reader;"), dev.load)
		await expect(replay).rejects.toThrow(
			new ReplayFailed(
				"comb could not read the roles url's server holds: permission denied for view pg_roles; check applies nothing",
			),
		)
	})
})

describe("throughPending", () => {
	it("reads the snapshot's files in order through the last pending one", () => {
		const copy = mkdtempSync(join(tmpdir(), "comb-through-pending-"))
		try {
			for (const name of ["1_a.sql", "2_b.sql", "3_c.sql"]) writeFileSync(join(copy, name), `-- ${name}`)
			expect(throughPending(copy, ["2_b.sql"])).toEqual([
				{ name: "1_a.sql", sql: "-- 1_a.sql" },
				{ name: "2_b.sql", sql: "-- 2_b.sql" },
			])
		} finally {
			rmSync(copy, { force: true, recursive: true })
		}
	})
})
