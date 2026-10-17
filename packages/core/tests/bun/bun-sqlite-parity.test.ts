/**
 * Driver parity on Bun's own engines. The query semantics run on libsql under vitest
 * (tests/integration/sqlite); this file proves the same SQL behaves the same on bun:sqlite,
 * and that Bun.SQL reports Postgres errors in the shape comb's handler reads. It runs under
 * `bun test` because vitest on Node cannot load `bun:sqlite` or `Bun.SQL`.
 */
import { SQL } from "bun"
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createListQuerySchema } from "../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../src/query/sqlite/build-list-query.ts"

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
