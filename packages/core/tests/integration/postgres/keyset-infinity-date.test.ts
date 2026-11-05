/**
 * U17 of the 0.12 round: a date-mode Postgres time column holding ±infinity. drizzle reads a
 * `timestamp` 'infinity' and '-infinity' both as 2000-01-01 local time, a valid Date the keyset
 * would page by, so the cursor's bound is read from its row. A `timestamptz` or `date` reads them as
 * an Invalid Date, which a cursor carries as itself, its bound read from the row too (3.24). A list
 * carries the key's to_json text beside it, 'infinity' or '-infinity', and binds that (AB3-4), so a
 * deleted infinite anchor resumes exactly where it stood.
 */
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { date, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { createCursor } from "../../../src/query/cursor-mint.ts"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { usePg } from "../support/pg.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { built } from "../../../src/query/__fixtures__/built.ts"

const vals = pgTable("vals", {
	d: date("d", { mode: "date" }),
	id: integer("id").primaryKey(),
	ts: timestamp("ts"),
	tz: timestamp("tz", { withTimezone: true }),
})
const schema = createListQuerySchema({ sort: ["ts", "tz", "d"], pagination: { defaultLimit: 1, maxLimit: 2 } })

/* ±infinity, a time before 2000 and after it, two in one millisecond (microseconds apart), and a NULL */
const ROWS = `INSERT INTO vals (id, ts) VALUES
	(1, 'infinity'), (2, '-infinity'), (3, '1999-06-01 00:00:00'), (4, '2026-01-03 04:05:06.789001'),
	(5, '2026-01-03 04:05:06.789002'), (6, NULL), (7, '2026-01-04'),
	/* a finite row at local 2000-01-01, the very Date node-postgres reads ±infinity as (U20) */
	(8, '2000-01-01 00:00:00')`

type Sessions = ReturnType<typeof usePg>

/* a cursor carrying its key's to_json text, which knows an infinity's sign (AB3-4), and one minted
 * from the Date alone, which may not */
const MINTS = [
	{ mint: "carrying its key's text", texts: true },
	{ mint: "minted from the Date alone", texts: false },
] as const

/** How `seen` served `all`: in order, or repeating rows, and then which it skipped */
function resumed(seen: number[], all: number[]) {
	const skipped = all.filter((id) => !seen.includes(id))
	return seen.length > all.length ? { repeated: true, skipped } : { repeated: false, seen }
}

/**
 * Every id, `limit` (1) at a time, under `order`; `edit` runs once on the first page that ends on `at`.
 * Without `texts` each cursor is minted from the row as read alone, as 0.20.1 minted it
 */
async function pageAll(
	sessions: Sessions,
	order: string,
	{
		at,
		edit = "DELETE FROM vals WHERE id = $1",
		limit = 1,
		texts = true,
	}: { at?: number; edit?: string; limit?: number; texts?: boolean } = {},
): Promise<number[]> {
	const client = sessions.pg()
	const db = drizzle({ client, relations: defineRelations({ vals }) })
	const query = schema.parse({ limit: String(limit), order })
	let anchor = at
	const seen: number[] = []
	let cursor: string | undefined
	for (let page = 0; page < 20; page++) {
		const rows = await db.query.vals.findMany(queryHelpers.listOptions({ ...query, cursor }, SEALED) as never)
		const read = texts ? rows : rows.map(({ _combKeyTexts, ...row }: Record<string, unknown>) => row)
		const [items, meta] = queryHelpers.paginate(read as Array<{ id: number }>, built({ ...query, cursor }, SEALED))
		seen.push(...items.map((row) => row.id))
		if (anchor !== undefined && items.at(-1)?.id === anchor) {
			await client.query(edit, [anchor])
			anchor = undefined
		}
		if (meta.nextCursor === null) return seen
		cursor = meta.nextCursor
	}
	throw new Error(`${order} did not end in 20 pages: ${seen.join(" ")}`)
}

/** The table seeded with `seed`, and each order's ids as Postgres itself orders them */
async function seeded(sessions: Sessions, seed = ROWS): Promise<(order: string) => Promise<number[]>> {
	const client = sessions.pg()
	await client.query("CREATE TEMP TABLE vals (id integer PRIMARY KEY, ts timestamp, tz timestamptz, d date)")
	await client.query(seed)
	return async (order) => {
		const [column, direction, nulls] = order.split(".") as [string, string, string | undefined]
		const placement =
			nulls === "nullslast" || (nulls === undefined && direction === "asc") ? "NULLS LAST" : "NULLS FIRST"
		const rows = await client.query(`SELECT id FROM vals ORDER BY ${column} ${direction} ${placement}, id ${direction}`)
		return rows.rows.map((row: { id: number }) => row.id)
	}
}

describe.each(MINTS)(
	"keyset pagination on a date-mode timestamp holding ±infinity (U17), a cursor $mint",
	({ texts }) => {
		const sessions = usePg()

		it.each(["ts.asc", "ts.desc"])("pages %s every row once, in Postgres's order", async (order) => {
			const inOrder = await seeded(sessions)
			expect(await pageAll(sessions, order, { texts })).toEqual(await inOrder(order))
		})

		it.each([
			["ts.asc", 4],
			["ts.desc", 5],
		] as const)("pages %s on exactly once its finite cursor row %s is deleted", async (order, at) => {
			const inOrder = await seeded(sessions)
			const all = await inOrder(order)
			expect(await pageAll(sessions, order, { at, texts })).toEqual(all)
		})

		/* the carried text keeps the infinity's sign (AB3-4); the Date read as 2000-01-01 lost it, so
		   such a cursor resumes from the direction's own end */
		it.each([
			["ts.asc", 1],
			["ts.desc.nullslast", 2],
		] as const)(
			"resumes %s, skipping none, once its infinite cursor row %s, at the far end, is deleted",
			async (order, at) => {
				const inOrder = await seeded(sessions)
				const all = await inOrder(order)
				expect(resumed(await pageAll(sessions, order, { at, texts }), all)).toEqual(
					texts ? { repeated: false, seen: all } : { repeated: true, skipped: [] },
				)
			},
		)

		it.each([
			["ts.asc", 2],
			["ts.desc", 1],
		] as const)(
			"pages %s on exactly once its infinite cursor row %s, at the near end, is deleted",
			async (order, at) => {
				const inOrder = await seeded(sessions)
				const all = await inOrder(order)
				expect(await pageAll(sessions, order, { at, texts })).toEqual(all)
			},
		)
	},
)

/* 3.24: two of each infinity, finite times on either side of them and a NULL, in a timestamptz or date */
const INFINITE = (column: string) => `INSERT INTO vals (id, ${column}) VALUES
	(1, 'infinity'), (2, '-infinity'), (3, '2026-01-01'), (4, '2026-01-02'), (5, NULL), (6, '2025-12-31'), (7, 'infinity'), (8, '-infinity')`

describe.each(MINTS)(
	"keyset pagination on a date-mode timestamptz or date holding ±infinity (3.24), a cursor $mint",
	({ texts }) => {
		const sessions = usePg()

		it.each(
			["tz.asc", "tz.desc", "tz.asc.nullsfirst", "d.asc", "d.desc", "d.desc.nullslast"].flatMap((order) => [
				[order, 1],
				[order, 2],
			]),
		)("pages %s, %s at a time, every row once in Postgres's order", async (order, limit) => {
			const inOrder = await seeded(sessions, INFINITE((order as string).split(".")[0] as string))
			expect(await pageAll(sessions, order as string, { limit: limit as number, texts })).toEqual(
				await inOrder(order as string),
			)
		})

		/* the carried text keeps the infinity's sign once the row is gone (AB3-4); a Date alone does not */
		it.each([
			["tz.asc", 1],
			["tz.desc", 2],
			["d.asc", 7],
			["d.desc", 8],
		] as const)("resumes %s, skipping none, once its infinite cursor row %s is deleted", async (order, at) => {
			const inOrder = await seeded(sessions, INFINITE(order.split(".")[0] as string))
			const all = await inOrder(order)
			const seen = await pageAll(sessions, order, { at, texts })
			expect(all.filter((id) => !seen.includes(id))).toEqual([])
			expect(texts ? seen : all).toEqual(all)
		})

		it("refuses a derived list's cursor at an infinite row, which no row can bound, with sort_not_wired", async () => {
			const inOrder = await seeded(sessions, INFINITE("tz"))
			expect(await inOrder("tz.asc")).toHaveLength(8)
			const query = schema.parse({ order: "tz.asc" })
			const row = { _combId: 1, id: 1, tz: new Date(Number.NaN) }
			expect(() => queryHelpers.paginate([row, row], built(query, { ...SEALED, keyset: "derived" }))).toThrow(
				expect.objectContaining({
					cause: expect.stringMatching(/^the sort by tz reads a date no JS Date holds/),
					errorKey: "sort_not_wired",
					status: 500,
				}),
			)
		})
	},
)

/*
 * U20 of the 0.13.0 round: the bound is the Date the cursor was minted from, read from the row only
 * when that Date is the one node-postgres gives both infinities and the row holds one. An anchor
 * edited between pages, an updated_at bump among them, then resumes where its old value stood.
 */
describe.each(MINTS)(
	"keyset pagination on a date-mode timestamp whose cursor row is edited between pages (U20), a cursor $mint",
	({ texts }) => {
		const sessions = usePg()
		const BUMP = "UPDATE vals SET ts = '2030-01-01' WHERE id = $1"

		it.each([
			["ts.asc", 4],
			["ts.desc", 5],
		] as const)("pages %s on past its finite cursor row %s bumped later, skipping none", async (order, at) => {
			const inOrder = await seeded(sessions)
			const all = await inOrder(order)
			const seen = await pageAll(sessions, order, { at, edit: BUMP, texts })
			const upTo = all.indexOf(at) + 1
			expect(seen.slice(0, upTo)).toEqual(all.slice(0, upTo))
			expect(seen.slice(upTo).filter((id) => id !== at)).toEqual(all.slice(upTo))
			expect(seen.filter((id) => id === at).length).toBeLessThanOrEqual(2)
		})

		/*
		 * Minted on a row whose Date is the one both infinities read as, which the edit leaves finite: an
		 * infinite row made finite, or row 8, whose finite 2000-01-01 reads as that very Date where the
		 * process runs in UTC (drizzle reads a finite `timestamp` as UTC, an infinite one as local
		 * 2000-01-01). Which the row was is gone, so the bound resumes from the direction's own end, as
		 * for a deleted row, repeating rows and skipping none, in every time zone.
		 */
		it.each([
			["ts.desc", 1],
			["ts.asc", 2],
			["ts.asc", 8],
			["ts.desc", 8],
		] as const)("skips no row on %s once its cursor row %s is edited to another finite value", async (order, at) => {
			const inOrder = await seeded(sessions)
			const all = await inOrder(order)
			const seen = await pageAll(sessions, order, { at, edit: BUMP, texts })
			expect(new Set(seen)).toEqual(new Set(all))
		})
	},
)

/*
 * AB4-5 of area B, 8a0dc7cd's Postgres half: under DateStyle 'SQL, DMY' in Asia/Kolkata node-postgres
 * reads every finite timestamptz as an Invalid Date. A cursor minted from such a row's Date alone, as
 * createCursor mints it, binds the row's own value while the row stands, so the list resumes past it;
 * bound from the direction's own end, every page served the first row again.
 */
describe("keyset pagination past a finite timestamptz read as an Invalid Date (AB4-5 of area B)", () => {
	const sessions = usePg()
	const kept = pgTable("kept", { id: text("id").primaryKey(), k: timestamp("k", { precision: 6, withTimezone: true }) })
	const bySchema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 3 }, sort: ["k"] })

	it("resumes past r1 from a cursor minted on its Date alone, serving r2 and r3", async () => {
		const client = sessions.pg()
		await client.query(`SET DateStyle = 'SQL, DMY'; SET TimeZone = 'Asia/Kolkata'`)
		await client.query("CREATE TEMP TABLE kept (id text PRIMARY KEY, k timestamptz(6))")
		await client.query(`INSERT INTO kept VALUES ('r0', '2024-01-01 00:00:00+00'), ('r1', '2024-01-01 02:00:00+00'),
			('r2', '2024-01-01 04:00:00+00'), ('r3', '2024-01-01 06:00:00+00')`)
		const db = drizzle({ client, relations: defineRelations({ kept }) })
		const read = await db.select().from(kept)
		expect(read.every((row) => Number.isNaN(row.k?.getTime()))).toBe(true)
		const anchor = read.find((row) => row.id === "r1") as (typeof read)[number]
		const parsed = bySchema.parse({ order: "k.asc" })
		/* one table-list page from `cursor`: its ids and its next cursor */
		const pageOf = async (cursor: string): Promise<[string[], string | null]> => {
			const list = buildListQuery({ ...SEALED, parsed: { ...parsed, cursor }, table: kept })
			const rows = await applyListQuery((extras) => db.select({ id: kept.id, k: kept.k, ...extras }).from(kept), list)
			const [items, meta] = queryHelpers.paginate(rows, list)
			return [items.map((row) => row.id), meta.nextCursor]
		}
		let cursor: string | null = createCursor({ ...anchor, _combId: anchor.id }, parsed.parsedSort, SEALED)
		const seen: string[] = []
		for (let page = 0; cursor !== null && page < 8; page++) {
			const [ids, next]: [string[], string | null] = await pageOf(cursor)
			seen.push(...ids)
			cursor = next
		}
		expect(seen).toEqual(["r2", "r3"])
	})
})
