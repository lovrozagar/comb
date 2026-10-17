/**
 * Driver parity on Bun's own engines. The query semantics run on libsql under vitest
 * (tests/integration/sqlite); this file proves the same SQL behaves the same on bun:sqlite,
 * and that Bun.SQL reports Postgres errors in the shape comb's handler reads. It runs under
 * `bun test` because vitest on Node cannot load `bun:sqlite` or `Bun.SQL`.
 */
import { SQL } from "bun"
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { CombError } from "../../src/error.ts"
import { createListQuerySchema } from "../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../src/query/sqlite/build-list-query.ts"
import { sqliteErrorHandler } from "../../src/sqlite/constraint-handler.ts"
import type { ConstraintMap } from "../../src/types.ts"

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
	return applyListQuery(open().select().from(item).$dynamic(), buildListQuery({ parsed, table: item }))
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

const PG_URL = process.env.COMB_TEST_PG_URL

describe("Bun.SQL error shape", () => {
	if (PG_URL === undefined || PG_URL === "") {
		it.skip("needs COMB_TEST_PG_URL (unset: skipped)", () => undefined)
		return
	}

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
