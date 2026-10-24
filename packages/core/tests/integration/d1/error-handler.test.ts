/**
 * D1 errors from workerd (Miniflare), through drizzle, as a Worker sees them. D1 reports the
 * SQLite result code at the end of its message; a platform failure carries none.
 */
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CombError } from "../../../src/error.ts"
import { d1ErrorHandler } from "../../../src/sqlite/d1/error-handler.ts"
import type { ConstraintMap } from "../../../src/types.ts"
import { type D1Harness, d1Memory } from "../support/d1.ts"

const DDL = [
	"CREATE TABLE org (id TEXT PRIMARY KEY)",
	`CREATE TABLE member (
		id TEXT PRIMARY KEY,
		email TEXT UNIQUE,
		org_id TEXT REFERENCES org(id),
		role TEXT NOT NULL DEFAULT 'user',
		seats INTEGER,
		CONSTRAINT member_id_check CHECK (id <> ''),
		CONSTRAINT member_seats_check CHECK (seats > 0)
	)`,
	"INSERT INTO org VALUES ('o1')",
	"INSERT INTO member (id, email) VALUES ('m1', 'reset@x')",
	/* U23: a composite key mapped on its first column, as codegen writes it, and a key no map lists */
	"CREATE TABLE parent (a TEXT, b TEXT, PRIMARY KEY (a, b))",
	"CREATE TABLE child (id TEXT PRIMARY KEY, pa TEXT, pb TEXT, FOREIGN KEY (pa, pb) REFERENCES parent (a, b))",
	"CREATE TABLE team (id TEXT PRIMARY KEY, name TEXT, owner_id TEXT REFERENCES org(id))",
	"INSERT INTO parent VALUES ('x', '1')",
	"INSERT INTO child VALUES ('c1', 'x', '1')",
	"INSERT INTO team VALUES ('t1', 'one', 'o1')",
]

const MAPS: ConstraintMap[] = [
	{
		member: {
			check: { member_seats_check: { cause: "Seats must be positive", errorKey: "member_seats_invalid" } },
			foreignKey: { org_id: { cause: "No such org", errorKey: "member_org_missing" } },
			primaryKey: { cause: "Member exists", errorKey: "member_id_taken" },
			unique: { email: { cause: "Email in use", errorKey: "member_email_taken" } },
		},
	},
]

/** What d1ErrorHandler throws for what `run` raises; undefined when it throws nothing. */
async function handled(run: () => Promise<unknown>): Promise<CombError | undefined> {
	const failure = await run().then(
		() => new Error("the statement did not fail"),
		(error: unknown) => error,
	)
	try {
		d1ErrorHandler(failure, MAPS)
	} catch (thrown) {
		return thrown as CombError
	}
	return undefined
}

describe("d1ErrorHandler on Miniflare through drizzle", () => {
	let harness: D1Harness

	beforeEach(async () => {
		harness = await d1Memory()
		for (const statement of DDL) await harness.CORE.prepare(statement).run()
	})

	afterEach(() => harness.dispose())

	const db = () => drizzle(harness.CORE)
	const run = (statement: string) => () => db().run(sql.raw(statement))

	it.each([
		["INSERT INTO member (id, email) VALUES ('m2', 'reset@x')", "member_email_taken", 409],
		["INSERT INTO member (id) VALUES ('m1')", "member_id_taken", 409],
		["INSERT INTO member (id, seats) VALUES ('m3', -1)", "member_seats_invalid", 400],
		["INSERT INTO member (id, org_id) VALUES ('m4', 'nope')", "member_org_missing", 409],
		["INSERT INTO member (id, role) VALUES ('m5', NULL)", "required_field_missing", 400],
	])("maps the constraint in %s", async (statement, errorKey, status) => {
		const error = await handled(run(statement))
		expect(error).toBeInstanceOf(CombError)
		expect(error).toMatchObject({ errorKey, status, table: "member" })
	})

	it("reports a bad query as a 500, even when its text or params mention a transient word", async () => {
		const missing = await handled(run("SELECT reset_at FROM member"))
		expect(missing).toMatchObject({ errorKey: "database_io_error", status: 500 })
		const params = await handled(() => db().run(sql`SELECT ${"reset connection"} FROM nowhere`))
		expect(params).toMatchObject({ errorKey: "database_io_error", status: 500 })
	})

	it("reports too many bound variables as a 500", async () => {
		const values = Array.from({ length: 101 }, (_, i) => i)
		const many = await handled(() =>
			harness.CORE.prepare(`SELECT ${values.map(() => "?").join(", ")}`)
				.bind(...values)
				.all(),
		)
		expect(many).toMatchObject({ errorKey: "database_io_error", status: 500 })
	})

	it("keeps SQL text and bound values out of the client-facing error and on source", async () => {
		const unique = await handled(() => db().run(sql`INSERT INTO member (id, email) VALUES (${"m9"}, ${"reset@x"})`))
		const missing = await handled(() => db().run(sql`SELECT reset_at FROM member WHERE id = ${"secret-id"}`))
		for (const error of [unique, missing]) {
			const visible = `${String(error?.cause)} ${JSON.stringify(error)}`
			expect(visible).not.toMatch(/reset@x|secret-id|SELECT|INSERT/i)
			expect(error?.source).toBeInstanceOf(Error)
		}
	})
})

describe("d1ErrorHandler on Miniflare: a trigger's RAISE", () => {
	let harness: D1Harness

	beforeEach(async () => {
		harness = await d1Memory()
	})
	afterEach(() => harness.dispose())

	const run = (statement: string) => () => drizzle(harness.CORE).run(sql.raw(statement))

	it("answers a trigger's RAISE with the 400 every engine gives, its message the cause", async () => {
		await harness.CORE.prepare("CREATE TABLE stock (qty INTEGER)").run()
		await harness.CORE.prepare(
			"CREATE TRIGGER qty_positive BEFORE INSERT ON stock WHEN new.qty <= 0 BEGIN SELECT RAISE(ABORT, 'qty must be positive'); END",
		).run()
		expect(await handled(run("INSERT INTO stock VALUES (0)"))).toMatchObject({
			cause: "qty must be positive",
			errorKey: "constraint_violation",
			status: 400,
		})
	})
})

/* U23 of the 0.13.0 round, on D1: an UPDATE of a foreign key column the map does not list */
describe("d1ErrorHandler on Miniflare: an UPDATE of a foreign key column the map does not list (U23)", () => {
	let harness: D1Harness

	beforeEach(async () => {
		harness = await d1Memory()
		for (const statement of DDL) await harness.CORE.prepare(statement).run()
	})

	afterEach(() => harness.dispose())

	const PARTIAL: ConstraintMap[] = [
		{
			child: { foreignKey: { pa: { cause: "No such parent", errorKey: "child_parent_missing" } } },
			team: { primaryKey: { cause: "Team exists", errorKey: "team_id_taken" } },
		},
	]

	it.each([
		["the second column of a composite key", "UPDATE child SET pb = '9' WHERE id = 'c1'", "child"],
		["a key the map leaves out", "UPDATE team SET owner_id = 'nope' WHERE id = 't1'", "team"],
	])("answers %s with the neutral cause", async (_, statement, table) => {
		const failure = await drizzle(harness.CORE)
			.run(sql.raw(statement))
			.then(
				() => new Error("the statement did not fail"),
				(error: unknown) => error,
			)
		expect(() => d1ErrorHandler(failure, PARTIAL)).toThrow(
			expect.objectContaining({
				cause: "Referenced record does not exist or is still in use",
				errorKey: "foreign_key_violation",
				table,
			}),
		)
	})
})
