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
