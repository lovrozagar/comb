/**
 * U17 of the 0.12 round: a date-mode Postgres time column holding ±infinity. drizzle reads a
 * `timestamp` 'infinity' and '-infinity' both as 2000-01-01 local time, a valid Date the keyset
 * would page by, so the cursor's bound is read from its row. A `timestamptz` or `date` reads them as
 * an Invalid Date, which no cursor carries: the page that meets one is the documented 500.
 */
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { date, integer, pgTable, timestamp } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { usePg } from "../support/pg.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

const vals = pgTable("vals", {
	d: date("d", { mode: "date" }),
	id: integer("id").primaryKey(),
	ts: timestamp("ts"),
	tz: timestamp("tz", { withTimezone: true }),
})
const schema = createListQuerySchema({ sort: ["ts", "tz", "d"], pagination: { defaultLimit: 1, maxLimit: 1 } })

/* ±infinity, a time before 2000 and after it, two in one millisecond (microseconds apart), and a NULL */
const ROWS = `INSERT INTO vals (id, ts) VALUES
	(1, 'infinity'), (2, '-infinity'), (3, '1999-06-01 00:00:00'), (4, '2026-01-03 04:05:06.789001'),
	(5, '2026-01-03 04:05:06.789002'), (6, NULL), (7, '2026-01-04')`

type Sessions = ReturnType<typeof usePg>

/** Every id, a page of one at a time, under `order`; `edit` runs once on the first page that ends on `at` */
async function pageAll(sessions: Sessions, order: string, at?: number): Promise<number[]> {
	const client = sessions.pg()
	const db = drizzle({ client, relations: defineRelations({ vals }) })
	const query = schema.parse({ order })
	const seen: number[] = []
	let cursor: string | undefined
	for (let page = 0; page < 20; page++) {
		const rows = await db.query.vals.findMany(queryHelpers.listOptions({ ...query, cursor }, SEALED) as never)
		const [items, meta] = queryHelpers.paginate(rows as Array<{ id: number }>, { ...query, cursor }, SEALED)
		seen.push(...items.map((row) => row.id))
		if (at !== undefined && items.at(-1)?.id === at) {
			await client.query("DELETE FROM vals WHERE id = $1", [at])
			at = undefined
		}
		if (meta.nextCursor === null) return seen
		cursor = meta.nextCursor
	}
	throw new Error(`${order} did not end in 20 pages: ${seen.join(" ")}`)
}

async function seeded(sessions: Sessions): Promise<(order: string) => Promise<number[]>> {
	const client = sessions.pg()
	await client.query("CREATE TEMP TABLE vals (id integer PRIMARY KEY, ts timestamp, tz timestamptz, d date)")
	await client.query(ROWS)
	return async (order) => {
		const [, direction, nulls] = order.split(".") as [string, string, string | undefined]
		const placement =
			nulls === "nullslast" || (nulls === undefined && direction === "asc") ? "NULLS LAST" : "NULLS FIRST"
		const rows = await client.query(`SELECT id FROM vals ORDER BY ts ${direction} ${placement}, id ${direction}`)
		return rows.rows.map((row: { id: number }) => row.id)
	}
}

describe("keyset pagination on a date-mode timestamp holding ±infinity (U17)", () => {
	const sessions = usePg()

	it.each(["ts.asc", "ts.desc"])("pages %s every row once, in Postgres's order", async (order) => {
		const inOrder = await seeded(sessions)
		expect(await pageAll(sessions, order)).toEqual(await inOrder(order))
	})

	it.each([
		["ts.asc", 4],
		["ts.desc", 5],
	] as const)("pages %s on exactly once its finite cursor row %s is deleted", async (order, at) => {
		const inOrder = await seeded(sessions)
		const all = await inOrder(order)
		expect(await pageAll(sessions, order, at)).toEqual(all)
	})

	/* resumed from the direction's own end, as the row may have held either infinity */
	it.each([
		["ts.asc", 1],
		["ts.desc.nullslast", 2],
	] as const)(
		"repeats rows and skips none on %s once its infinite cursor row %s, at the far end, is deleted",
		async (order, at) => {
			const inOrder = await seeded(sessions)
			const all = await inOrder(order)
			const seen = await pageAll(sessions, order, at)
			expect(all.filter((id) => !seen.includes(id))).toEqual([])
			expect(seen.length).toBeGreaterThan(all.length)
		},
	)

	it.each([
		["ts.asc", 2],
		["ts.desc", 1],
	] as const)("pages %s on exactly once its infinite cursor row %s, at the near end, is deleted", async (order, at) => {
		const inOrder = await seeded(sessions)
		const all = await inOrder(order)
		expect(await pageAll(sessions, order, at)).toEqual(all)
	})
})

describe("a date-mode timestamptz or date holding ±infinity (U17)", () => {
	const sessions = usePg()

	it.each(["tz", "d"])(
		"answers the page that meets one with sort_not_wired, naming both dialects' cause (%s)",
		async (column) => {
			const client = sessions.pg()
			await client.query("CREATE TEMP TABLE vals (id integer PRIMARY KEY, ts timestamp, tz timestamptz, d date)")
			await client.query(
				`INSERT INTO vals (id, ${column}) VALUES (1, '2026-01-01'), (2, 'infinity'), (3, '2026-01-02')`,
			)
			const db = drizzle({ client, relations: defineRelations({ vals }) })
			const query = schema.parse({ order: `${column}.asc` })
			const rows = (await db.query.vals.findMany(
				queryHelpers.listOptions({ ...query, limit: 3 }, SEALED) as never,
			)) as Array<{ id: number }>
			/* the page that ends on the infinite row, and the row after it */
			const page = [rows.find((row) => row.id === 2), rows.find((row) => row.id === 3)] as Array<{ id: number }>
			expect(() => queryHelpers.paginate(page, { ...query, limit: 1 }, SEALED)).toThrow(
				expect.objectContaining({
					cause: expect.stringContaining(
						"a Postgres 'infinity' read in date mode, or a SQLite seconds timestamp holding ±Infinity",
					),
					errorKey: "sort_not_wired",
					status: 500,
				}),
			)
		},
	)
})
