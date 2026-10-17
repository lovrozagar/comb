/**
 * comb's Postgres timestamp columns hold epoch milliseconds (about 1.76e12), past a 4-byte
 * integer's 2147483647. The columns and their defaults must take today's time on a real server.
 */
import { getTableColumns, type SQL } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { PgDialect, pgTable } from "drizzle-orm/pg-core"
import { expect, it } from "vitest"
import { c } from "../../../src/pg/columns.ts"
import { describePg, usePg } from "../support/pg.ts"

const stamp = pgTable("stamp", {
	created_at: c.createdAt("created_at"),
	deleted_at: c.deletedAt("deleted_at"),
	id: c.serialId(),
	seen_at: c.timestamp("seen_at"),
	updated_at: c.updatedAt("updated_at"),
})

const dialect = new PgDialect()

/** CREATE TEMP TABLE from the columns' own SQL types and defaults */
function ddl(): string {
	const columns = Object.values(getTableColumns(stamp)).map((column) => {
		const fallback = column.default === undefined ? "" : ` DEFAULT ${dialect.sqlToQuery(column.default as SQL).sql}`
		const type = column.columnType === "PgSerial" ? "serial PRIMARY KEY" : column.getSQLType()
		return `"${column.name}" ${type}${column.notNull && column.columnType !== "PgSerial" ? " NOT NULL" : ""}${fallback}`
	})
	return `CREATE TEMP TABLE stamp (${columns.join(", ")})`
}

describePg("pg columns hold epoch milliseconds (plan 3.10)", () => {
	const sessions = usePg()

	it("defaults created_at and updated_at to now, and stores a millisecond timestamp", async () => {
		await sessions.pg().query(ddl())
		const db = drizzle({ client: sessions.pg() })
		const before = Date.now()
		const [row] = await db.insert(stamp).values({ deleted_at: before, seen_at: before }).returning()
		expect(row?.seen_at).toBe(before)
		expect(row?.deleted_at).toBe(before)
		expect(typeof row?.created_at).toBe("number")
		expect(Math.abs((row?.created_at ?? 0) - before)).toBeLessThan(60_000)
		expect(Math.abs((row?.updated_at ?? 0) - before)).toBeLessThan(60_000)
	})
})
