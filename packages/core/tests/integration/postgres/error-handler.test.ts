/**
 * Postgres errors from a real server, raw and through drizzle, on both Node drivers. The
 * drivers name the same fields differently (node-postgres `constraint`, postgres.js
 * `constraint_name`), and drizzle wraps either one on `cause`.
 */
import { sql } from "drizzle-orm"
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import pg from "pg"
import { expect, it } from "vitest"
import { CombError } from "../../../src/error.ts"
import { pgErrorHandler } from "../../../src/pg/error-handler.ts"
import type { ConstraintMap } from "../../../src/types.ts"
import { describePg, type PgSessions, pgUrl, usePg } from "../support/pg.ts"

/* 60 characters: Postgres cuts the name of its primary key to fit 63 bytes */
const LONG = "a_table_whose_name_runs_long_enough_that_its_pkey_is_cut_xyz"

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
	CREATE TEMP TABLE ${LONG} (id text PRIMARY KEY);
	INSERT INTO ${LONG} VALUES ('l1');
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
				"first,last": { cause: "Name in use", errorKey: "member_name_taken" },
			},
		},
		[LONG]: { primaryKey: { cause: "Long row exists", errorKey: "long_id_taken" } },
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
		column: undefined,
		errorKey: "member_name_taken",
		name: "composite unique, by its columns together",
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

		it(`${driver}: says a row is still referenced when a delete fails on a child's key`, async () => {
			const thrown = await handled(sessions, runner, "DELETE FROM org WHERE id = 'o1'")
			expect(thrown).toMatchObject({
				cause: "The record is still referenced by other records",
				errorKey: "foreign_key_violation",
			})
			expect((thrown as CombError).column).toBeUndefined()
			/* the statement's table, as SQLite names it, wherever the SQL is recorded: on drizzle's wrapper,
			   and on postgres.js's own error; bare node-postgres records none (R11) */
			expect((thrown as CombError).table).toBe(driver === "node-postgres" ? undefined : "org")
		})

		it(`${driver}: finds the primary key of a table whose name Postgres cut`, async () => {
			const thrown = await handled(sessions, runner, `INSERT INTO ${LONG} VALUES ('l1')`)
			expect(thrown).toMatchObject({ errorKey: "long_id_taken", table: LONG })
		})

		it.each([
			["99999999999 into an int4", "SELECT 99999999999::int4"],
			["a word as an integer", "SELECT 'x'::int"],
			["a word as a date", "SELECT 'nope'::date"],
			["a day past the month's end", "SELECT '2024-02-30'::date"],
		])(`${driver}: maps %s to a 400 invalid_value (Q-D11)`, async (_, statement) => {
			expect(await handled(sessions, runner, statement)).toMatchObject({ errorKey: "invalid_value", status: 400 })
		})

		it(`${driver}: leaves a non-constraint error alone`, async () => {
			expect(await handled(sessions, runner, "SELECT reset_at FROM member")).toBe("not handled")
		})

		it(`${driver}: leaves a division by zero, the server's own SQL, alone`, async () => {
			expect(await handled(sessions, runner, "SELECT 1 / 0")).toBe("not handled")
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

	it("maps a backend the server terminates (57P01) to 503 database_unavailable, as no maintenance is under way", async () => {
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
		expect(caught(failure)).toMatchObject({ errorKey: "database_unavailable", status: 503 })
	})
})

describePg("pgErrorHandler on a real server: a busy server", () => {
	const sessions = usePg()

	it("maps a lock it gave up waiting for (55P03) to 503, a retry", async () => {
		const a = sessions.pg()
		const b = sessions.sql()
		await a.query("BEGIN")
		try {
			await a.query("SELECT pg_advisory_xact_lock(7710)")
			const failure = await b
				.begin(async (tx) => {
					await tx`SET LOCAL lock_timeout = '50ms'`
					await tx`SELECT pg_advisory_xact_lock(7710)`
				})
				.then(
					() => null,
					(error: unknown) => error,
				)
			expect(failure).toMatchObject({ code: "55P03" })
			expect(caught(failure)).toMatchObject({ errorKey: "database_unavailable", status: 503 })
		} finally {
			await a.query("ROLLBACK")
		}
	})

	it("maps too many connections for a role (53300) to 503", async () => {
		const role = `comb_nolimit_${Math.random().toString(36).slice(2, 8)}`
		const admin = sessions.pg()
		await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'x' CONNECTION LIMIT 0`)
		try {
			const url = new URL(pgUrl() as string)
			url.username = role
			url.password = "x"
			const client = new pg.Client({ connectionString: url.href })
			const failure = await client.connect().then(
				() => null,
				(error: unknown) => error,
			)
			await client.end().catch(() => undefined)
			expect(failure).toMatchObject({ code: "53300" })
			expect(caught(failure)).toMatchObject({ errorKey: "database_unavailable", status: 503 })
		} finally {
			await admin.query(`DROP ROLE ${role}`)
		}
	})
})

describePg("pgErrorHandler on a real server: a session the server ends for idling", () => {
	const sessions = usePg()

	/** The error the server sends `victim` when it ends the session after `setting` passes */
	async function endedFor(setting: string, inTransaction: boolean): Promise<unknown> {
		const victim = sessions.pg()
		const ended = new Promise<unknown>((resolve) => victim.on("error", resolve))
		if (inTransaction) await victim.query("BEGIN")
		await victim.query(`SET ${inTransaction ? "LOCAL " : ""}${setting} = '100ms'`)
		return ended
	}

	it("maps an idle session the server ended (57P05) to 503", async () => {
		const failure = await endedFor("idle_session_timeout", false)
		expect(failure).toMatchObject({ code: "57P05" })
		expect(caught(failure)).toMatchObject({ errorKey: "database_unavailable", status: 503 })
	})

	it("maps an idle transaction the server ended (25P03) to 503", async () => {
		const failure = await endedFor("idle_in_transaction_session_timeout", true)
		expect(failure).toMatchObject({ code: "25P03" })
		expect(caught(failure)).toMatchObject({ errorKey: "database_unavailable", status: 503 })
	})
})

describePg("pgErrorHandler on a real server: values a request can send (Q8)", () => {
	const sessions = usePg()
	const MAPS_Q8: ConstraintMap[] = [
		{ booking: { exclusion: { booking_no_overlap: { cause: "Room booked", errorKey: "room_booked" } } } },
	]

	/** What pgErrorHandler throws for the failure of `statement`, after `ddl` */
	async function failure(ddl: string, statement: string, params: unknown[] = []): Promise<unknown> {
		const client = sessions.pg()
		await client.query(ddl)
		const error = await client.query(statement, params).then(
			() => new Error("the statement did not fail"),
			(caughtError: unknown) => caughtError,
		)
		try {
			pgErrorHandler(error, MAPS_Q8)
		} catch (thrown) {
			return thrown
		}
		return "not handled"
	}

	it.each([
		["a string past varchar(8)", "CREATE TEMP TABLE v (s varchar(8))", "123456789"],
		["a NUL byte in text", "CREATE TEMP TABLE v (s text)", "a\u0000b"],
	])("maps %s, bound as a request sends it, to a 400 invalid_value", async (_, ddl, value) => {
		expect(await failure(ddl, "INSERT INTO v VALUES ($1)", [value])).toMatchObject({
			errorKey: "invalid_value",
			status: 400,
		})
	})

	it("maps a value too large for its unique index's row to a 400 value_too_large", async () => {
		expect(
			await failure(
				"CREATE TEMP TABLE v (s text UNIQUE)",
				"INSERT INTO v SELECT string_agg(md5(random()::text), '') FROM generate_series(1, 400)",
			),
		).toMatchObject({ errorKey: "value_too_large", status: 400 })
	})

	it("answers a trigger's RAISE EXCEPTION (P0001) with the 400 SQLite gives, its message the cause", async () => {
		expect(
			await failure(
				"CREATE TEMP TABLE stock (qty int); CREATE FUNCTION pg_temp.qty_positive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.qty <= 0 THEN RAISE EXCEPTION 'qty must be positive'; END IF; RETURN NEW; END $$; CREATE TRIGGER qty_positive BEFORE INSERT ON stock FOR EACH ROW EXECUTE FUNCTION pg_temp.qty_positive()",
				"INSERT INTO stock VALUES (0)",
			),
		).toMatchObject({ cause: "qty must be positive", errorKey: "constraint_violation", status: 400 })
	})

	it("maps an overlapping row under an EXCLUDE constraint through the map", async () => {
		expect(
			await failure(
				"CREATE TEMP TABLE booking (during tsrange, CONSTRAINT booking_no_overlap EXCLUDE USING gist (during WITH &&)); INSERT INTO booking VALUES ('[2026-01-01 10:00, 2026-01-01 12:00)')",
				"INSERT INTO booking VALUES ('[2026-01-01 11:00, 2026-01-01 13:00)')",
			),
		).toMatchObject({ errorKey: "room_booked", status: 409, table: "booking" })
	})
})
