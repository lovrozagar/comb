/**
 * A date filter's epoch milliseconds on a column that stores whole seconds (drizzle's integer
 * `timestamp` mode), on a real libsql database: each bound rounds the way that keeps it exact.
 */
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { filterToSQL } from "../../../src/query/sqlite/executor.ts"
import type { FilterAST } from "../../../src/query/types.ts"

const event = sqliteTable("event", {
	at: integer("at", { mode: "timestamp" }).notNull(),
	name: text("name").primaryKey(),
})

const client = createClient({ url: ":memory:" })
const db = drizzle({ client })

beforeAll(async () => {
	await client.executeMultiple(
		"CREATE TABLE event (name TEXT PRIMARY KEY, at INTEGER NOT NULL); INSERT INTO event VALUES ('at-1000ms', 1), ('at-2000ms', 2);",
	)
})
afterAll(() => client.close())

/** The rows a filter of `operator` on `at` with `ms` matches */
async function matched(operator: string, ms: number): Promise<string[]> {
	const filter: FilterAST = {
		root: { conditions: [{ field: "at", operator, value: ms } as never], logic: "and", subgroups: [] },
	}
	const where = filterToSQL(filter, { mainTable: event }) ?? undefined
	const rows = await db.select({ name: event.name }).from(event).where(where).orderBy(event.name)
	return rows.map((row) => row.name)
}

describe("a date filter on a seconds-mode timestamp (Q3)", () => {
	it.each([
		["lt", 1500, ["at-1000ms"]],
		["lte", 1500, ["at-1000ms"]],
		["gt", 1500, ["at-2000ms"]],
		["gte", 1500, ["at-2000ms"]],
		["eq", 1500, []],
		["ne", 1500, ["at-1000ms", "at-2000ms"]],
		["eq", 2000, ["at-2000ms"]],
		["ne", 2000, ["at-1000ms"]],
		["gte", 2000, ["at-2000ms"]],
		["lt", -500, []],
	])("%s %d matches %j", async (operator, ms, rows) => {
		expect(await matched(operator, ms)).toEqual(rows)
	})
})
