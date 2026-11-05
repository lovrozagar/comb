/**
 * AB4-7 of area B on libsql: a cursor binds a SQLite REAL key as `cast(? as real)` of the text the
 * list checked, and SQLite plans the page as it plans a bound number: a SEARCH on the key's index where
 * the limit is known (drizzle binds it, which SQLite plans as an ordered SCAN of that index either way).
 */
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery } from "../../../src/query/sqlite/build-list-query.ts"

const post = sqliteTable("post", { id: text("id").primaryKey(), s: integer("s", { mode: "timestamp" }) })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["s"] })

describe("a REAL key's cursor bound as its text keeps the key's index (AB4-7 of area B)", () => {
	it("searches the key's index for the page after a REAL", async () => {
		const client = createClient({ url: ":memory:" })
		await client.execute("CREATE TABLE post (id TEXT PRIMARY KEY, s INTEGER)")
		await client.execute("CREATE INDEX post_s ON post (s, id)")
		/* enough rows that the planner weighs the index, as it would on a table worth paging */
		await client.execute(
			"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000) INSERT INTO post SELECT 'r' || i, i + 0.5 FROM n",
		)
		const db = drizzle({ client })
		const statement = (cursor?: string) => {
			const parsed = { ...schema.parse({ order: "s.asc" }), cursor }
			const list = buildDerivedListQuery({ ...SEALED, idColumn: post.id, parsed, sortColumns: { s: post.s } })
			return [
				list,
				applyListQuery((extras: object) => db.select({ id: post.id, s: post.s, ...extras }).from(post), list),
			] as const
		}
		const [first, query] = statement()
		const [, { nextCursor }] = queryHelpers.paginate(await query, first)
		const [, next] = statement(nextCursor as string)
		const { params, sql } = next.toSQL()
		expect(sql).toContain("cast(? as real)")
		const planOf = async (planned: string, args: readonly unknown[]) =>
			(await client.execute({ args: args as never, sql: `EXPLAIN QUERY PLAN ${planned}` })).rows.map((row) =>
				String(row["detail"]),
			)
		/* drizzle binds the limit, which SQLite plans as unknown, so it scans the index in order with or without the cast */
		expect(await planOf(sql, params)).toEqual(await planOf(sql.replaceAll("cast(? as real)", "?"), params))
		/* with the limit known, the key's bounds are a SEARCH on its index, a cast bound as a number is */
		const known = sql.replace(/limit \?$/, "limit 1")
		const plan = await planOf(known, params.slice(0, -1))
		expect(
			plan.filter((detail) => detail.startsWith("SEARCH")),
			plan.join(" | "),
		).not.toEqual([])
		expect(
			plan.every((detail) => !detail.startsWith("SCAN") && (!detail.startsWith("SEARCH") || detail.includes("post_s"))),
		).toBe(true)
		expect(plan).toEqual(await planOf(known.replaceAll("cast(? as real)", "?"), params.slice(0, -1)))
		client.close()
	})
})
