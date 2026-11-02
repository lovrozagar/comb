import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { replayPending, throughPending } from "./pg-check-replay.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { ReplayFailed } from "./replay-failed.ts"

beforeAll(loadPostgresParser)

const TARGET = { devUrl: "postgres://dev/dev", lockTimeout: "5s", schema: "public", url: "postgres://app/app" }
const file = (sql: string) => [{ name: "1_a.sql", sql }]

/* the replay's database, named for the run's start and a random suffix */
const DATABASE = /comb_replay_\d{13}_[0-9a-f]{8}/g

/* what every replay sends before and after the history: the sweep, its database made and copied into, and dropped */
const AROUND = {
	after: ["DROP DATABASE IF EXISTS <db>"],
	before: [
		expect.stringMatching(/^SELECT datname FROM pg_database/),
		expect.stringMatching(/^SELECT r\.rolname/),
		"CREATE DATABASE <db> TEMPLATE template0",
		expect.stringMatching(/^SELECT e\.extname/),
		'SET search_path TO "public"',
	],
}

/** A postgres.js stand-in on every connection: each query it was sent, the replay's database as <db>, failing those `fail` names */
function fake(fail?: (query: string) => Error | undefined) {
	const sent: string[] = []
	const connect = () => ({
		end: async () => undefined,
		unsafe: async (query: string) => {
			sent.push(query.replaceAll(DATABASE, "<db>"))
			const error = fail?.(query)
			if (error !== undefined) throw error
			return []
		},
	})
	return { load: async () => connect, sent }
}

/** A load of postgres.js where it is not installed */
const noPeer = async (): Promise<never> => {
	throw new Error("install postgres (^3.4.0), an optional peer, and run it again")
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
			sent: [...AROUND.before, "BEGIN", "CREATE TABLE t (a int)", "COMMIT", ...AROUND.after],
		})
	})

	it("says it replayed nothing on Atlas's own docker:// container, and connects to nothing", async () => {
		const { out, sent } = await replayed("CREATE TABLE t (a int);", { devUrl: "docker://postgres/17/dev" })
		expect(out).toEqual([
			"Check did not replay the pending files on devUrl: docker://postgres/17/dev is Atlas's own container, which comb cannot reach, so a statement Postgres refuses on every database is found only when it applies; set devUrl to a postgres:// scratch database comb can connect to",
		])
		expect(sent).toEqual([])
	})

	it("says it replayed nothing without the postgres package, naming why", async () => {
		const { out } = await replayed("CREATE TABLE t (a int);", { load: noPeer })
		expect(out).toEqual([
			"Check did not replay the pending files on devUrl: install postgres (^3.4.0), an optional peer, and run it again",
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
		expect(sent).toEqual([...AROUND.before, "BEGIN", "CREATE TABLE t (a int)", "COMMIT", ...AROUND.after])
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
