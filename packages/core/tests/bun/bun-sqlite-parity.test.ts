/// <reference types="bun-types" />
/**
 * Driver parity on Bun's own engines. The query semantics run on libsql under vitest
 * (tests/integration/sqlite); this file proves the same SQL behaves the same on bun:sqlite,
 * and that Bun.SQL reports Postgres errors in the shape comb's handler reads. It runs under
 * `bun test` because vitest on Node cannot load `bun:sqlite` or `Bun.SQL`.
 */
import { SQL } from "bun"
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { getTableColumns, sql } from "drizzle-orm"
import { drizzle as bunSqlDrizzle } from "drizzle-orm/bun-sql"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { CombError } from "../../src/error.ts"
import { pgErrorHandler } from "../../src/pg/error-handler.ts"
import { queryHelpers } from "../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../src/query/sqlite/build-list-query.ts"
import { sqliteErrorHandler } from "../../src/sqlite/constraint-handler.ts"
import type { ConstraintMap } from "../../src/types.ts"
import { SEALED } from "../../src/query/__fixtures__/cursor-secret.ts"
import { built } from "../../src/query/__fixtures__/built.ts"

const item = sqliteTable("item", {
	amount: integer("amount"),
	created_at: integer("created_at").notNull(),
	id: text("id").primaryKey(),
	vendor: text("vendor").notNull(),
})

const schema = createListQuerySchema({ filter: { amount: "number", vendor: "string" }, sort: ["amount", "vendor"] })

function open() {
	const sqlite = new Database(":memory:")
	sqlite.run(
		"CREATE TABLE item (id TEXT PRIMARY KEY, vendor TEXT NOT NULL, amount INTEGER, created_at INTEGER NOT NULL)",
	)
	const rows: Array<[string, string, number | null]> = [
		["i1", "acme", 7],
		["i2", "ACME", 8],
		["i3", "a?c", null],
		["i4", "abc", 1],
	]
	rows.forEach(([id, vendor, amount], index) => {
		sqlite.run("INSERT INTO item (id, vendor, amount, created_at) VALUES (?, ?, ?, ?)", [id, vendor, amount, index])
	})
	return drizzle({ client: sqlite })
}

function vendors(query: Record<string, string>): string[] {
	const parsed = schema.parse({ limit: "50", ...query })
	return applyListQuery(
		(extras) =>
			open()
				.select({ ...getTableColumns(item), ...extras })
				.from(item),
		buildListQuery({ ...SEALED, parsed, table: item }),
	)
		.all()
		.map((row) => row.vendor)
}

describe("bun:sqlite runs comb's list queries like libsql does", () => {
	it("like is case-sensitive with * as the only wildcard, ilike ignores ASCII case", () => {
		expect(vendors({ filter: "vendor.like.acme" })).toEqual(["acme"])
		expect(vendors({ filter: "vendor.ilike.acme" }).sort()).toEqual(["ACME", "acme"])
		expect(vendors({ filter: "vendor.like.a?c" })).toEqual(["a?c"])
	})

	it("orders nulls last ascending by default", () => {
		expect(vendors({ order: "amount.asc" })).toEqual(["abc", "acme", "ACME", "a?c"])
	})
})

describe("bun:sqlite with safeIntegers pages by cursor (R3)", () => {
	it("pages an integer sort every row once, though every INTEGER comes back a bigint", () => {
		const raw = new Database(":memory:", { safeIntegers: true })
		raw.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)")
		raw.exec("INSERT INTO item VALUES (1, 30), (2, 10), (3, 50), (4, 9007199254740993), (5, 40)")
		const counted = sqliteTable("item", { id: integer("id").primaryKey(), n: integer("n").notNull() })
		const db = drizzle({ client: raw })
		const byN = createListQuerySchema({ sort: ["n"], pagination: { defaultLimit: 2, maxLimit: 2 } })
		const ids: string[] = []
		let cursor: string | undefined
		for (let guard = 0; guard < 6; guard++) {
			const parsed = byN.parse({ cursor, order: "n.asc" })
			const rows = applyListQuery(
				(extras) => db.select({ ...getTableColumns(counted), ...extras }).from(counted),
				buildListQuery({ ...SEALED, parsed, table: counted }),
			).all()
			const [items, pagination] = queryHelpers.paginate(rows, built(parsed, SEALED))
			ids.push(...items.map((row) => String(row.id)))
			if (pagination.nextCursor === null) break
			cursor = pagination.nextCursor
		}
		expect(ids).toEqual(["2", "1", "5", "3", "4"])
		raw.close()
	})
})

describe("bun:sqlite constraint errors map like libsql's", () => {
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

	function errorKeyOf(statement: string): string {
		const sqlite = new Database(":memory:")
		sqlite.run("PRAGMA foreign_keys = ON")
		sqlite.run("CREATE TABLE org (id TEXT PRIMARY KEY)")
		sqlite.run(
			"CREATE TABLE member (id TEXT PRIMARY KEY, email TEXT UNIQUE, org_id TEXT REFERENCES org(id), seats INTEGER, CONSTRAINT member_status_check CHECK (id <> ''), CONSTRAINT member_seats_check CHECK (seats > 0))",
		)
		sqlite.run("INSERT INTO member (id, email) VALUES ('m1', 'a@x')")
		try {
			drizzle({ client: sqlite }).run(sql.raw(statement))
		} catch (error) {
			try {
				sqliteErrorHandler(error, MAPS)
			} catch (thrown) {
				return (thrown as CombError).errorKey
			}
		}
		return "not handled"
	}

	it.each([
		["INSERT INTO member (id, email) VALUES ('m2', 'a@x')", "member_email_taken"],
		["INSERT INTO member (id) VALUES ('m1')", "member_id_taken"],
		["INSERT INTO member (id, seats) VALUES ('m3', -1)", "member_seats_invalid"],
		["INSERT INTO member (id, org_id) VALUES ('m4', 'nope')", "member_org_missing"],
	])("%s → %s", (statement, errorKey) => {
		expect(errorKeyOf(statement)).toBe(errorKey)
	})
})

/* U23 of the 0.13.0 round, on bun:sqlite: an UPDATE of a foreign key column the map does not list */
describe("bun:sqlite answers an UPDATE of a foreign key column the map does not list neutrally (U23)", () => {
	const PARTIAL: ConstraintMap[] = [
		{
			child: { foreignKey: { pa: { cause: "No such parent", errorKey: "child_parent_missing" } } },
			team: { primaryKey: { cause: "Team exists", errorKey: "team_id_taken" } },
		},
	]

	/** What sqliteErrorHandler throws for `statement` on the U23 schema */
	function thrownBy(statement: string): CombError | undefined {
		const sqlite = new Database(":memory:")
		for (const ddl of [
			"PRAGMA foreign_keys = ON",
			"CREATE TABLE org (id TEXT PRIMARY KEY)",
			"INSERT INTO org VALUES ('o1')",
			"CREATE TABLE parent (a TEXT, b TEXT, PRIMARY KEY (a, b))",
			"CREATE TABLE child (id TEXT PRIMARY KEY, pa TEXT, pb TEXT, FOREIGN KEY (pa, pb) REFERENCES parent (a, b))",
			"CREATE TABLE team (id TEXT PRIMARY KEY, name TEXT, owner_id TEXT REFERENCES org(id))",
			"INSERT INTO parent VALUES ('x', '1')",
			"INSERT INTO child VALUES ('c1', 'x', '1')",
			"INSERT INTO team VALUES ('t1', 'one', 'o1')",
		])
			sqlite.run(ddl)
		try {
			drizzle({ client: sqlite }).run(sql.raw(statement))
		} catch (error) {
			try {
				sqliteErrorHandler(error, PARTIAL)
			} catch (thrown) {
				return thrown as CombError
			}
		}
		return undefined
	}

	it.each([
		["UPDATE child SET pb = '9' WHERE id = 'c1'", "child"],
		["UPDATE team SET owner_id = 'nope' WHERE id = 't1'", "team"],
	])("%s answers the neutral cause", (statement, table) => {
		expect(thrownBy(statement)).toMatchObject({
			cause: "Referenced record does not exist or is still in use",
			errorKey: "foreign_key_violation",
			table,
		})
	})
})

/* required, as in the vitest suites: a run without the server would pass with these skipped */
const PG_URL = process.env.COMB_TEST_PG_URL ?? ""
if (PG_URL === "") throw new Error("COMB_TEST_PG_URL is unset: the Bun.SQL cases are required (docs/testing.md)")

describe("Bun.SQL error shape", () => {
	it("reports SQLSTATE in errno and the constraint name", async () => {
		const client = new SQL({ max: 1, url: PG_URL })
		try {
			await client.unsafe("CREATE TEMP TABLE u (email text CONSTRAINT u_email_key UNIQUE)")
			await client`INSERT INTO u VALUES (${"x"})`
			const failure = await client`INSERT INTO u VALUES (${"x"})`.then(
				() => null,
				(error: unknown) => error,
			)
			expect(failure).toMatchObject({ constraint: "u_email_key", errno: "23505", table: "u" })
		} finally {
			await client.close()
		}
	})
})

describe("pgErrorHandler on Bun.SQL, raw and through drizzle", () => {
	const MAPS: ConstraintMap[] = [
		{
			member: {
				primaryKey: { cause: "Member exists", errorKey: "member_id_taken" },
				unique: { email: { cause: "Email in use", errorKey: "member_email_taken" } },
			},
		},
	]

	async function errorOf(statement: string, viaDrizzle: boolean): Promise<CombError | undefined> {
		const client = new SQL({ max: 1, url: PG_URL })
		try {
			await client.unsafe(
				"CREATE TEMP TABLE member (id text PRIMARY KEY, email text CONSTRAINT member_email_key UNIQUE, role text NOT NULL DEFAULT 'u'); INSERT INTO member (id, email) VALUES ('m1', 'a@x')",
			)
			const run = viaDrizzle ? bunSqlDrizzle({ client }).execute(sql.raw(statement)) : client.unsafe(statement)
			const failure = await run.then(
				() => null,
				(error: unknown) => error,
			)
			pgErrorHandler(failure, MAPS)
		} catch (thrown) {
			return thrown as CombError
		} finally {
			await client.close()
		}
		return undefined
	}

	it.each([
		["INSERT INTO member (id, email) VALUES ('m2', 'a@x')", "member_email_taken", "email"],
		["INSERT INTO member (id) VALUES ('m1')", "member_id_taken", undefined],
		["INSERT INTO member (id, role) VALUES ('m3', NULL)", "required_field_missing", "role"],
	])("%s → %s", async (statement, errorKey, column) => {
		for (const viaDrizzle of [false, true]) {
			const error = await errorOf(statement, viaDrizzle)
			expect(error).toMatchObject({ errorKey, table: "member" })
			expect(error?.column).toBe(column)
		}
	})
})

describe("bun:sqlite maps an expression index and a STRICT mismatch as libsql does (Q9, Q10)", () => {
	const maps: ConstraintMap[] = [
		{ account: { unique: { u_email_lower: { cause: "Email taken", errorKey: "email_taken" } } } },
	]

	/** What sqliteErrorHandler throws for `statement` on a database with an expression index and a STRICT table */
	function handled(statement: string): unknown {
		const sqlite = new Database(":memory:")
		sqlite.run("CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT)")
		sqlite.run("CREATE UNIQUE INDEX u_email_lower ON account (lower(email))")
		sqlite.run("INSERT INTO account VALUES ('a1', 'a@b.c')")
		sqlite.run("CREATE TABLE s (id TEXT PRIMARY KEY, n INTEGER) STRICT")
		try {
			drizzle({ client: sqlite }).run(sql.raw(statement))
		} catch (error) {
			try {
				sqliteErrorHandler(error, maps)
			} catch (thrown) {
				return thrown
			}
		}
		return "not handled"
	}

	it("finds the index by name and answers the mismatch with a 400", () => {
		expect(handled("INSERT INTO account VALUES ('a2', 'A@B.C')")).toMatchObject({ errorKey: "email_taken" })
		expect(handled("INSERT INTO s VALUES ('x', 'abc')")).toMatchObject({
			column: "n",
			errorKey: "invalid_value",
			status: 400,
		})
	})
})

describe("bun:sqlite answers a trigger's RAISE as libsql does", () => {
	it("is a 400 constraint_violation with the trigger's message", () => {
		const sqlite = new Database(":memory:")
		sqlite.run("CREATE TABLE stock (qty INTEGER)")
		sqlite.run(
			"CREATE TRIGGER qty_positive BEFORE INSERT ON stock WHEN new.qty <= 0 BEGIN SELECT RAISE(ABORT, 'qty must be positive'); END",
		)
		let thrown: unknown
		try {
			drizzle({ client: sqlite }).run(sql.raw("INSERT INTO stock VALUES (0)"))
		} catch (error) {
			try {
				sqliteErrorHandler(error, [])
			} catch (mapped) {
				thrown = mapped
			}
		}
		expect(thrown).toMatchObject({ cause: "qty must be positive", errorKey: "constraint_violation", status: 400 })
	})
})
