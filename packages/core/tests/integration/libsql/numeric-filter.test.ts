/**
 * A number field over drizzle's `numeric()` column, which drizzle labels "string numeric", on a
 * real libsql database: the column's NUMERIC affinity compares a number as a number (U35b).
 */
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { numeric, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { filterToSQL } from "../../../src/query/sqlite/executor.ts"
import type { FilterAST } from "../../../src/query/types.ts"

const price = sqliteTable("price", {
	amount: numeric("amount").notNull(),
	name: text("name").primaryKey(),
})

const client = createClient({ url: ":memory:" })
const db = drizzle({ client })

beforeAll(async () => {
	await client.executeMultiple(
		"CREATE TABLE price (name TEXT PRIMARY KEY, amount NUMERIC NOT NULL); INSERT INTO price VALUES ('two', 2), ('nine-and-a-half', 9.5), ('ten', 10);",
	)
})
afterAll(() => client.close())

/** The rows a filter of `operator` on `amount` with `value` matches */
async function matched(operator: string, value: unknown): Promise<string[]> {
	const filter: FilterAST = {
		root: { conditions: [{ field: "amount", operator, value } as never], logic: "and", subgroups: [] },
	}
	const where = filterToSQL(filter, { mainTable: price }) ?? undefined
	const rows = await db.select({ name: price.name }).from(price).where(where).orderBy(price.name)
	return rows.map((row) => row.name)
}

describe("a number field on a numeric column", () => {
	it.each([
		["eq", 10, ["ten"]],
		["gte", 9.5, ["nine-and-a-half", "ten"]],
		["lt", 3, ["two"]],
		["in", [2, 10], ["ten", "two"]],
	])("%s %j matches %j, as numbers compare", async (operator, value, rows) => {
		expect(await matched(operator, value)).toEqual(rows)
	})

	it("still lowers text on it, which the column's affinity reads as a number", async () => {
		expect(await matched("eq", "10")).toEqual(["ten"])
	})
})
