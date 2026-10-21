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
	/* a parent with a foreign key of its own, still referenced by a child (fkdelete.ts) */
	"CREATE TABLE author (id TEXT PRIMARY KEY)",
	"CREATE TABLE post (id TEXT PRIMARY KEY, author_id TEXT REFERENCES author(id))",
	"CREATE TABLE comment (id TEXT PRIMARY KEY, post_id TEXT REFERENCES post(id))",
	"INSERT INTO author VALUES ('a1')",
	"INSERT INTO post VALUES ('p1', 'a1')",
	"INSERT INTO comment VALUES ('c1', 'p1')",
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
				"first,last": { cause: "Name in use", errorKey: "member_name_taken" },
			},
		},
		post: { foreignKey: { author_id: { cause: "No such author", errorKey: "post_author_missing" } } },
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
		column: undefined,
		errorKey: "member_name_taken",
		name: "a composite unique, by its columns together",
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

describe("sqliteErrorHandler on libsql: a delete of a row others still reference (C2)", () => {
	const db = useMemberDb()

	it("says the row is still referenced, and blames no foreign key of the deleted table", async () => {
		const thrown = await classify(db(), "DELETE FROM post WHERE id = 'p1'")
		expect(thrown).toMatchObject({
			cause: "The record is still referenced by other records",
			errorKey: "foreign_key_violation",
			status: 409,
			table: "post",
		})
		expect((thrown as CombError).column).toBeUndefined()
	})

	it("reports a composite unique that no map names as the pair, never as its first column", async () => {
		const unmapped = [{ member: { unique: { first: { cause: "First in use", errorKey: "member_first_taken" } } } }]
		const thrown = await classify(db(), "INSERT INTO member (id, first, last) VALUES ('m9', 'Ada', 'L')", {
			maps: unmapped,
		})
		expect(thrown).toMatchObject({
			cause: "Duplicate value for member.first, member.last",
			errorKey: "unique_constraint_violation",
		})
	})
})

describe("sqliteErrorHandler on libsql: an expression index and a STRICT column (Q9, Q10)", () => {
	const db = useMemberDb()
	const maps: ConstraintMap[] = [
		{ account: { unique: { u_email_lower: { cause: "Email taken", errorKey: "email_taken" } } } },
	]
	const setup = [
		"CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT)",
		"CREATE UNIQUE INDEX u_email_lower ON account (lower(email))",
		"INSERT INTO account VALUES ('a1', 'a@b.c')",
		"CREATE TABLE s (id TEXT PRIMARY KEY, n INTEGER) STRICT",
	]

	it("maps a unique expression index by name, as Postgres maps the constraint", async () => {
		for (const statement of setup) await db().client.execute(statement)
		expect(await classify(db(), "INSERT INTO account VALUES ('a2', 'A@B.C')", { maps })).toMatchObject({
			errorKey: "email_taken",
			status: 409,
			table: "account",
		})
	})

	it("answers text in a STRICT INTEGER column with the 400 Postgres gives", async () => {
		for (const statement of setup) await db().client.execute(statement)
		expect(await classify(db(), "INSERT INTO s VALUES ('x', 'abc')", { maps })).toMatchObject({
			column: "n",
			errorKey: "invalid_value",
			status: 400,
			table: "s",
		})
	})
})

describe("sqliteErrorHandler on libsql: a trigger's RAISE", () => {
	const db = useMemberDb()

	it.each(["ABORT", "FAIL"])(
		"answers RAISE(%s, …) with a 400 constraint_violation, its message the cause",
		async (kind) => {
			await db().client.execute("CREATE TABLE stock (qty INTEGER)")
			await db().client.execute(
				`CREATE TRIGGER qty_positive BEFORE INSERT ON stock WHEN new.qty <= 0 BEGIN SELECT RAISE(${kind}, 'qty must be positive'); END`,
			)
			expect(await classify(db(), "INSERT INTO stock VALUES (0)")).toMatchObject({
				cause: "qty must be positive",
				errorKey: "constraint_violation",
				status: 400,
			})
		},
	)
})
