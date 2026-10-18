/**
 * Postgres errors from a real server, raw and through drizzle, on both Node drivers. The
 * drivers name the same fields differently (node-postgres `constraint`, postgres.js
 * `constraint_name`), and drizzle wraps either one on `cause`.
 */
import { sql } from "drizzle-orm"
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import { expect, it } from "vitest"
import { CombError } from "../../../src/error.ts"
import { pgErrorHandler } from "../../../src/pg/error-handler.ts"
import type { ConstraintMap } from "../../../src/types.ts"
import { describePg, type PgSessions, usePg } from "../support/pg.ts"

const DDL = `
	CREATE TEMP TABLE org (id text PRIMARY KEY);
	CREATE TEMP TABLE member (
		id text PRIMARY KEY,
		email text CONSTRAINT member_email_key UNIQUE,
		first text,
		last text,
		org_id text CONSTRAINT member_org_id_fkey REFERENCES org(id),
		role text NOT NULL DEFAULT 'user',
		seats int CONSTRAINT member_seats_check CHECK (seats > 0),
		status text CONSTRAINT member_status_check CHECK (status IN ('on', 'off')),
		CONSTRAINT member_first_last_key UNIQUE (first, last)
	);
	INSERT INTO org VALUES ('o1');
	INSERT INTO member (id, email, first, last, org_id) VALUES ('m1', 'a@x', 'Ada', 'L', 'o1');
`

const MAPS: ConstraintMap[] = [
	{
		member: {
			check: {
				member_seats_check: { cause: "Seats must be positive", errorKey: "member_seats_invalid" },
				member_status_check: { cause: "Unknown status", errorKey: "member_status_invalid" },
			},
			foreignKey: { org_id: { cause: "No such org", errorKey: "member_org_missing" } },
			primaryKey: { cause: "Member exists", errorKey: "member_id_taken" },
			unique: {
				email: { cause: "Email in use", errorKey: "member_email_taken" },
				first: { cause: "Name in use", errorKey: "member_name_taken" },
			},
		},
	},
]

const CASES = [
	{
		column: "email",
		errorKey: "member_email_taken",
		name: "unique",
		sql: "INSERT INTO member (id, email) VALUES ('m2', 'a@x')",
	},
	{ column: undefined, errorKey: "member_id_taken", name: "primary key", sql: "INSERT INTO member (id) VALUES ('m1')" },
	{
		column: "first",
		errorKey: "member_name_taken",
		name: "composite unique",
		sql: "INSERT INTO member (id, first, last) VALUES ('m3', 'Ada', 'L')",
	},
	{
		column: undefined,
		errorKey: "member_seats_invalid",
		name: "second CHECK",
		sql: "INSERT INTO member (id, seats) VALUES ('m4', -1)",
	},
	{
		column: "org_id",
		errorKey: "member_org_missing",
		name: "foreign key",
		sql: "INSERT INTO member (id, org_id) VALUES ('m5', 'nope')",
	},
	{
		column: "role",
		errorKey: "required_field_missing",
		name: "NOT NULL",
		sql: "INSERT INTO member (id, role) VALUES ('m6', NULL)",
	},
]

type Runner = (sessions: PgSessions, statement: string) => Promise<unknown>

const RUNNERS: Record<string, Runner> = {
	"node-postgres": (s, statement) => s.pg().query(statement),
	"node-postgres via drizzle": (s, statement) => drizzlePg({ client: s.pg() }).execute(sql.raw(statement)),
	"postgres.js": (s, statement) => s.sql().unsafe(statement),
	"postgres.js via drizzle": (s, statement) => drizzlePostgres({ client: s.sql() }).execute(sql.raw(statement)),
}

/** What pgErrorHandler throws for the error `statement` raises; "not handled" when it throws nothing. */
async function handled(sessions: PgSessions, runner: Runner, statement: string): Promise<unknown> {
	await sessions.sql().unsafe(DDL)
	await sessions.pg().query(DDL)
	const failure = await runner(sessions, statement).then(
		() => new Error("the statement did not fail"),
		(error: unknown) => error,
	)
	try {
		pgErrorHandler(failure, MAPS)
	} catch (thrown) {
		return thrown
	}
	return "not handled"
}

describePg("pgErrorHandler on a real server", () => {
	const sessions = usePg()

	for (const [driver, runner] of Object.entries(RUNNERS)) {
		it.each(CASES)(`${driver}: maps $name`, async ({ column, errorKey, sql: statement }) => {
			const thrown = await handled(sessions, runner, statement)
			expect(thrown).toBeInstanceOf(CombError)
			expect(thrown).toMatchObject({ errorKey, table: "member" })
			expect((thrown as CombError).column).toBe(column)
			expect((thrown as CombError).source).toBeInstanceOf(Error)
		})

		it(`${driver}: leaves a non-constraint error alone`, async () => {
			expect(await handled(sessions, runner, "SELECT reset_at FROM member")).toBe("not handled")
		})
	}
})

const caught = (error: unknown) => {
	try {
		pgErrorHandler(error, [])
	} catch (thrown) {
		return thrown
	}
	return "not handled"
}

describePg("pgErrorHandler on a real server: retryable failures", () => {
	const sessions = usePg()

	it("maps a statement timeout (57014) to 503", async () => {
		const failure = await sessions
			.sql()
			.begin(async (tx) => {
				await tx`SET LOCAL statement_timeout = 1`
				await tx`SELECT pg_sleep(1)`
			})
			.then(
				() => null,
				(error: unknown) => error,
			)
		expect(failure).toMatchObject({ code: "57014" })
		expect(caught(failure)).toMatchObject({ errorKey: "database_unavailable", status: 503 })
	})

	it("maps a deadlock (40P01) to 503", async () => {
		/* two sessions take the same two advisory locks in opposite order; no table needed */
		const a = sessions.pg()
		const b = sessions.sql()
		await a.query("BEGIN")
		await b`BEGIN`
		try {
			await a.query("SELECT pg_advisory_xact_lock(7701)")
			await b`SELECT pg_advisory_xact_lock(7702)`
			const results = await Promise.allSettled([
				a.query("SELECT pg_advisory_xact_lock(7702)"),
				b`SELECT pg_advisory_xact_lock(7701)`,
			])
			const failure = results.find((result) => result.status === "rejected")
			const reason = (failure as PromiseRejectedResult | undefined)?.reason as unknown
			expect(reason).toMatchObject({ code: "40P01" })
			expect(caught(reason)).toMatchObject({ errorKey: "database_unavailable", status: 503 })
		} finally {
			await Promise.allSettled([a.query("ROLLBACK"), b`ROLLBACK`])
		}
	})
})

describePg("pgErrorHandler on a real server: a server that refuses or ends the session", () => {
	const sessions = usePg()

	it("maps a write in a read-only transaction (25006) to 503 database_readonly", async () => {
		/* refused before anything is created: the suite never leaves a table behind */
		const failure = await sessions
			.sql()
			.begin("READ ONLY", async (tx) => {
				await tx`CREATE TABLE comb_read_only_probe (id int)`
			})
			.then(
				() => null,
				(error: unknown) => error,
			)
		expect(failure).toMatchObject({ code: "25006" })
		expect(caught(failure)).toMatchObject({ errorKey: "database_readonly", status: 503 })
	})

	it("maps a backend the server terminates (57P01) to 503 database_readonly", async () => {
		/* node-postgres reads the server's error before the socket closes; postgres.js reports only the close */
		const victim = sessions.pg()
		victim.on("error", () => undefined)
		const { rows } = await victim.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
		const pid = rows[0]?.pid
		const sleeping = victim.query("SELECT pg_sleep(5)").then(
			() => null,
			(error: unknown) => error,
		)
		/* wait until the sleep is running on that backend, then end it from another session */
		const admin = sessions.sql()
		for (let tries = 0; tries < 50; tries++) {
			const [activity] = await admin`SELECT state FROM pg_stat_activity WHERE pid = ${pid as number}`
			if (activity?.["state"] === "active") break
			await new Promise((resolve) => setTimeout(resolve, 20))
		}
		await admin`SELECT pg_terminate_backend(${pid as number})`
		const failure = await sleeping
		expect(failure).toMatchObject({ code: "57P01" })
		expect(caught(failure)).toMatchObject({ errorKey: "database_readonly", status: 503 })
	})
})
