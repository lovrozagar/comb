/**
 * Q2 of r19, part 4, on Postgres: node-postgres reads count(*), an int8, as a decimal string, so a
 * derived list keyed by it carries "3" in its cursor. Postgres types a bound parameter by the operand
 * it meets, so the cursor's string compares as the integer it is, and the list pages every row once:
 * the SQLite typeof extra is not needed here.
 */
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { pgTable, text } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { buildDerivedListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { usePg } from "../support/pg.ts"

/* a temp table, which Postgres finds first by its bare name */
const member = pgTable("member", { org: text("org").notNull() })

describe("a derived list keyed by count(*), on Postgres through node-postgres", () => {
	const sessions = usePg()

	it.each(["asc", "desc"] as const)("pages %s every group once, the count read as a string", async (direction) => {
		await sessions.pg().query(`CREATE TEMP TABLE member (org text NOT NULL);
INSERT INTO member VALUES ('a'), ('b'), ('c'), ('c'), ('c'), ('d'), ('e'), ('e');`)
		const db = drizzle({ client: sessions.pg() })
		const ids: string[] = []
		let cursor: string | undefined
		let read: unknown
		for (let guard = 0; guard < 8; guard++) {
			const built = buildDerivedListQuery({
				...SEALED,
				idColumn: member.org,
				parsed: { cursor, limit: 2, parsedSort: [{ direction, field: "k" }] },
				sortColumns: { k: sql`count(*)` },
			})
			const query = db
				.select({ id: member.org, k: sql`count(*)`, ...built.extras })
				.from(member)
				.groupBy(member.org)
				.$dynamic()
			const rows = await (built.where ? query.having(built.where) : query).orderBy(...built.orderBy).limit(built.limit)
			read ??= rows[0]?.k
			const [items, pagination] = queryHelpers.paginate(rows, built)
			ids.push(...items.map((row) => row.id))
			if (pagination.nextCursor === null) break
			cursor = pagination.nextCursor
		}
		expect(typeof read).toBe("string")
		expect(ids).toEqual(direction === "asc" ? ["a", "b", "d", "e", "c"] : ["c", "e", "d", "b", "a"])
	})
})
