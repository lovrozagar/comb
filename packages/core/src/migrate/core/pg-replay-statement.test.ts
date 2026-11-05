/**
 * One statement of a history file as the dev replay runs it (PR5 of r22b): one in a tablespace the
 * replay left out runs in pg_default and is reported, any other runs as it is, and devUrl's refusal
 * of either is the replay's, naming the file and the statement. Postgres runs each in
 * replay-left-out.test.ts; this holds the fakes no server gives.
 */
import { beforeAll, describe, expect, it, vi } from "vitest"
import { nodeOf } from "./pg-outside-transaction.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import type { Run } from "./pg-replay-roles.ts"
import { type Replaying, runStatement } from "./pg-replay-statement.ts"
import { pgRead } from "./pg-split.ts"
import { ReplayFailed } from "./replay-failed.ts"

beforeAll(loadPostgresParser)

/** `sql`'s one statement from file 2_b.sql, as nodeOf reads it */
function statement(sql: string) {
	const [read] = pgRead(sql).statements
	const [type, node] = nodeOf(read?.tree as never)
	return { name: "2_b.sql", node, sent: String(read?.sent), type }
}

/* devUrl's refusal of a statement, as Postgres codes a missing privilege */
const DENIED = Object.assign(new Error("permission denied (42501)"), { code: "42501" })

/**
 * A run that left out the tablespaces `left`, as a role with CREATEROLE or not, whose connection
 * records what it is sent and refuses what starts with `refused`
 */
function run(left: string[], refused?: string, createrole = false) {
	const sent: string[] = []
	const unsafe = async (query: string) => {
		if (refused !== undefined && query.startsWith(refused)) throw DENIED
		sent.push(query)
		return []
	}
	const on = { created: [], createrole, sql: { unsafe }, superuser: false, tablespaces: new Set(left) }
	return { run: on as unknown as Run, sent }
}

/** The replay's words, each callback a mock */
function replaying(): Replaying {
	return {
		doing: "replaying the history",
		leftOut: vi.fn(),
		movedTo: vi.fn(),
		refused: (what, error) => new ReplayFailed(`${what}: ${String(error)}`),
		stops: "check",
		waits: vi.fn(async () => {}),
	}
}

describe("runStatement", () => {
	it("runs a statement in a tablespace the replay left out in pg_default, and says so", async () => {
		const { run: on, sent } = run(["fast"])
		const replay = replaying()
		await runStatement(on, statement("CREATE TABLE t (id int) TABLESPACE fast;"), replay)
		expect(sent).toEqual(["CREATE TABLE t (id int) TABLESPACE pg_default"])
		expect(replay.movedTo).toHaveBeenCalledWith("2_b.sql", "CREATE TABLE t (id int) TABLESPACE fast", ["fast"])
		expect(replay.waits).not.toHaveBeenCalled()
	})

	it("runs any other statement as it is, saying nothing", async () => {
		const { run: on, sent } = run([])
		const replay = replaying()
		await runStatement(on, statement("CREATE TABLE t (id int) TABLESPACE fast;"), replay)
		expect(sent).toEqual(["CREATE TABLE t (id int) TABLESPACE fast"])
		expect(replay.movedTo).not.toHaveBeenCalled()
	})

	it("waits on the extensions that follow one a file makes", async () => {
		const { run: on, sent } = run([])
		const replay = replaying()
		await runStatement(on, statement("CREATE EXTENSION hstore;"), replay)
		expect(sent).toEqual(["CREATE EXTENSION hstore"])
		expect(replay.waits).toHaveBeenCalledWith(on.sql)
	})

	/* PR9 of r22b */
	it("refuses a CREATE ROLE devUrl's role lacks CREATEROLE for, naming the privilege, as NO_CREATEDB names CREATEDB", async () => {
		const { run: on } = run([], 'CREATE ROLE "app"')
		await expect(runStatement(on, statement("CREATE ROLE app;"), replaying())).rejects.toThrow(
			"2_b.sql creates the role app, which devUrl's server lacks, and devUrl's role cannot create a role (CREATEROLE), as comb replays the history in a database of its own on that server; grant the role CREATEROLE, or point devUrl at a server where it has it; check",
		)
	})

	it("refuses a CREATE ROLE with devUrl's own error when its role has CREATEROLE", async () => {
		const { run: on } = run([], 'CREATE ROLE "app"', true)
		await expect(runStatement(on, statement("CREATE ROLE app;"), replaying())).rejects.toThrow(
			'2_b.sql: devUrl refused "CREATE ROLE app" as replaying the history: Error: permission denied (42501)',
		)
	})

	it("refuses with devUrl's error, naming the file, the statement and what the replay was doing", async () => {
		const { run: on } = run([], "CREATE TABLE t (id int)")
		await expect(runStatement(on, statement("CREATE TABLE t (id int);"), replaying())).rejects.toThrow(
			'2_b.sql: devUrl refused "CREATE TABLE t (id int)" as replaying the history: Error: permission denied (42501)',
		)
	})
})
