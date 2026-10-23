/**
 * A sort key holding a value JSON has no number for (R4): Postgres `double precision` holds
 * ±Infinity and NaN, and `timestamp` holds 'infinity', a common "valid until" sentinel. Each is
 * paged one row at a time through queryHelpers.listOptions and paginate, and every row comes back
 * once, in the order Postgres gives. A timestamp that may hold 'infinity' is read in string mode:
 * drizzle's date mode parses it as 2000-01-01 local time, a wrong value comb cannot tell apart.
 */
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { doublePrecision, integer, pgTable, timestamp } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { usePg } from "../support/pg.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

const point = pgTable("point", {
	at: timestamp("at", { mode: "string", precision: 3 }),
	id: integer("id").primaryKey(),
	x: doublePrecision("x"),
})
const schema = createListQuerySchema({ sort: ["at", "x"], pagination: { defaultLimit: 1, maxLimit: 1 } })

const ROWS = `INSERT INTO point (id, x, at) VALUES
	(1, 'Infinity', 'infinity'), (2, '-Infinity', '-infinity'), (3, 'NaN', '2026-01-03'),
	(4, 1.5, '2026-01-04'), (5, NULL, NULL), (6, -2, '2026-01-01 00:00:00.5'), (7, 'Infinity', 'infinity')`

describe("keyset pagination on keys JSON has no number for (R4)", () => {
	const sessions = usePg()

	/** Every id, a page of one at a time, under `order` */
	async function pageAll(order: string): Promise<number[]> {
		const db = drizzle({ client: sessions.pg(), relations: defineRelations({ point }) })
		const query = schema.parse({ order })
		const seen: number[] = []
		let cursor: string | undefined
		for (let page = 0; page < 12; page++) {
			const options = queryHelpers.listOptions({ ...query, cursor }, SEALED)
			const rows = await db.query.point.findMany(options as never)
			const [items, meta] = queryHelpers.paginate(rows as Array<{ id: number }>, { ...query, cursor }, SEALED)
			seen.push(...items.map((row) => row.id))
			if (meta.nextCursor === null) return seen
			cursor = meta.nextCursor
		}
		throw new Error(`${order} did not end in 12 pages`)
	}

	it.each(["x.asc", "x.desc", "x.asc.nullsfirst", "at.asc", "at.desc"])(
		"pages %s every row once, in Postgres's order",
		async (order) => {
			const client = sessions.pg()
			await client.query("CREATE TEMP TABLE point (id integer PRIMARY KEY, x double precision, at timestamp(3))")
			await client.query(ROWS)
			const [field, direction, nulls] = order.split(".") as [string, string, string | undefined]
			const placement = nulls === "nullsfirst" ? "NULLS FIRST" : direction === "asc" ? "NULLS LAST" : "NULLS FIRST"
			const once = await client.query(
				`SELECT id FROM point ORDER BY ${field} ${direction} ${placement}, id ${direction}`,
			)
			expect(await pageAll(order)).toEqual(once.rows.map((row: { id: number }) => row.id))
		},
	)
})
