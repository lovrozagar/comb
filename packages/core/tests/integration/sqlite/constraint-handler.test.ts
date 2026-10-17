/**
 * SQLite constraint violations, raised by a real engine and seen the way an app sees them:
 * through drizzle, whose `DrizzleQueryError` wraps the engine error on `cause`.
 */
import { sql } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CombError } from "../../../src/error.ts"
import { handleConstraintViolation, sqliteErrorHandler } from "../../../src/sqlite/constraint-handler.ts"
import type { ConstraintMap } from "../../../src/types.ts"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"

const DDL = [
	"PRAGMA foreign_keys = ON",
	"CREATE TABLE org (id TEXT PRIMARY KEY)",
	`CREATE TABLE member (
		id TEXT PRIMARY KEY,
		email TEXT UNIQUE,
		first TEXT,
		last TEXT,
		org_id TEXT REFERENCES org(id),
		role TEXT NOT NULL DEFAULT 'user',
		status TEXT,
		seats INTEGER,
		CONSTRAINT member_status_check CHECK (status IN ('on', 'off')),
		CONSTRAINT member_seats_check CHECK (seats > 0),
		UNIQUE (first, last)
	)`,
	"INSERT INTO org VALUES ('o1')",
	"INSERT INTO member (id, email, first, last, org_id) VALUES ('m1', 'a@x', 'Ada', 'L', 'o1')",
]

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

type Classify = { handler?: (error: unknown, maps: ConstraintMap[]) => void; maps?: ConstraintMap[] }

/** What `handler` throws for the engine error that `statement` raises through drizzle. */
async function classify(harness: LibsqlHarness, statement: string, options: Classify = {}): Promise<unknown> {
	const { handler = sqliteErrorHandler, maps = MAPS } = options
	const failure = await harness.db.run(sql.raw(statement)).then(
		() => null,
		(error: unknown) => error,
	)
	expect(failure).toBeInstanceOf(Error)
	try {
		handler(failure, maps)
	} catch (thrown) {
		return thrown
	}
	return "not handled"
}

/** A fresh database with the member schema for every test. */
function useMemberDb(): () => LibsqlHarness {
	let harness: LibsqlHarness | undefined
	beforeEach(async () => {
		harness = libsqlMemory()
		for (const statement of DDL) await harness.client.execute(statement)
	})
	afterEach(() => harness?.close())
	return () => harness as LibsqlHarness
}

const MAPPED = [
	{
		column: "email",
		errorKey: "member_email_taken",
		name: "a unique column",
		status: 409,
		sql: "INSERT INTO member (id, email) VALUES ('m2', 'a@x')",
	},
	{
		column: undefined,
		errorKey: "member_id_taken",
		name: "the primary key",
		status: 409,
		sql: "INSERT INTO member (id) VALUES ('m1')",
	},
	{
		column: "first",
		errorKey: "member_name_taken",
		name: "a composite unique, by its first column",
		status: 409,
		sql: "INSERT INTO member (id, first, last) VALUES ('m3', 'Ada', 'L')",
	},
	{
		column: undefined,
		errorKey: "member_seats_invalid",
		name: "the second named CHECK",
		status: 400,
		sql: "INSERT INTO member (id, seats) VALUES ('m4', -1)",
	},
	{
		column: undefined,
		errorKey: "member_status_invalid",
		name: "the first named CHECK",
		status: 400,
		sql: "INSERT INTO member (id, status) VALUES ('m5', 'zzz')",
	},
	{
		column: "org_id",
		errorKey: "member_org_missing",
		name: "a foreign key",
		status: 409,
		sql: "INSERT INTO member (id, org_id) VALUES ('m6', 'nope')",
	},
	{
		column: "role",
		errorKey: "required_field_missing",
		name: "NOT NULL, with its column",
		status: 400,
		sql: "INSERT INTO member (id, role) VALUES ('m7', NULL)",
	},
]

describe("sqliteErrorHandler on libsql through drizzle: mapped", () => {
	const db = useMemberDb()

	it.each(MAPPED)("maps $name", async ({ column, errorKey, sql: statement, status }) => {
		const thrown = await classify(db(), statement)
		expect(thrown).toBeInstanceOf(CombError)
		expect(thrown).toMatchObject({ errorKey, status, table: "member" })
		expect((thrown as CombError).column).toBe(column)
	})

	it("handleConstraintViolation takes the error itself, wrapper and all", async () => {
		const thrown = await classify(db(), "INSERT INTO member (id, email) VALUES ('m2', 'a@x')", {
			handler: handleConstraintViolation,
		})
		expect(thrown).toMatchObject({ errorKey: "member_email_taken" })
	})

	it("keeps the engine error off the client-facing cause and on source", async () => {
		const thrown = (await classify(db(), "INSERT INTO member (id, email) VALUES ('m2', 'a@x')")) as CombError
		expect(thrown.cause).toBe("Email in use")
		expect(thrown.source).toBeInstanceOf(Error)
		expect(JSON.stringify(thrown)).not.toContain("INSERT")
	})
})

describe("sqliteErrorHandler on libsql through drizzle: unmapped", () => {
	const db = useMemberDb()

	it.each([
		["INSERT INTO member (id, email) VALUES ('m2', 'a@x')", "unique_constraint_violation"],
		["INSERT INTO member (id) VALUES ('m1')", "primary_key_violation"],
		["INSERT INTO member (id, seats) VALUES ('m4', -1)", "check_constraint_violation"],
		["INSERT INTO member (id, org_id) VALUES ('m6', 'nope')", "foreign_key_violation"],
	])("falls back to the generic key: %s → %s", async (statement, errorKey) => {
		expect(await classify(db(), statement, { maps: [] })).toMatchObject({ errorKey })
	})

	it("leaves an error that is not a constraint violation alone", async () => {
		expect(await classify(db(), "SELECT reset_at FROM member")).toBe("not handled")
		expect(() => sqliteErrorHandler(new Error("boom"), MAPS)).not.toThrow()
		expect(() => sqliteErrorHandler("text", MAPS)).not.toThrow()
	})
})
