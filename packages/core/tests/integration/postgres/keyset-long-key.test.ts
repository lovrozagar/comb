/**
 * A sort key too long for a cursor on Postgres (R8): the cursor carries the row's id and a prefix,
 * and the keyset reads the value from the row. Exact while the row is there. Once it is deleted, a
 * column sorted by code point (C or POSIX) resumes from the prefix, repeating rows that share it and
 * skipping none; under any other collation neither prefix bound is safe, and the list ends.
 */
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { describePg, usePg } from "../support/pg.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

const doc = pgTable("doc", { id: integer("id").primaryKey(), title: text("title").notNull() })
const schema = createListQuerySchema({ sort: ["title"], pagination: { defaultLimit: 1, maxLimit: 1 } })
const LONG = "長".repeat(3000)
const ROWS = [`${LONG}b`, "a", `${LONG}a`, `${LONG}c`, "zz", `${LONG}a`, "長"]

type Sessions = ReturnType<typeof usePg>

async function seeded(sessions: Sessions, collation: string) {
	const client = sessions.pg()
	await client.query(`CREATE TEMP TABLE doc (id integer PRIMARY KEY, title text COLLATE ${collation} NOT NULL)`)
	for (const [i, title] of ROWS.entries()) await client.query("INSERT INTO doc VALUES ($1, $2)", [i + 1, title])
}

/** Every id under `order`, one row a page; the first long row a page ends on is deleted when `drop` */
async function pageAll(
	sessions: Sessions,
	order: string,
	drop: boolean,
): Promise<{ deleted: number[]; seen: number[] }> {
	const client = sessions.pg()
	const db = drizzle({ client, relations: defineRelations({ doc }) })
	const seen: number[] = []
	const deleted: number[] = []
	let cursor: string | undefined
	for (let guard = 0; guard < 30; guard++) {
		const query = { ...schema.parse({ order }), cursor }
		const rows = await db.query.doc.findMany(queryHelpers.listOptions(query, SEALED) as never)
		const [items, meta] = queryHelpers.paginate(rows as Array<{ id: number; title: string }>, query, SEALED)
		seen.push(...items.map((row) => row.id))
		if (meta.nextCursor === null) return { deleted, seen }
		expect(meta.nextCursor.length).toBeLessThanOrEqual(8192)
		const last = items.at(-1) as { id: number; title: string }
		if (drop && deleted.length === 0 && last.title.length > 100) {
			deleted.push(last.id)
			await client.query("DELETE FROM doc WHERE id = $1", [last.id])
		}
		cursor = meta.nextCursor
	}
	throw new Error(`${order} did not end in 30 pages`)
}

/** The ids in Postgres's own order */
async function inOrder(sessions: Sessions, order: string): Promise<number[]> {
	const direction = order.endsWith("desc") ? "DESC" : "ASC"
	const result = await sessions.pg().query(`SELECT id FROM doc ORDER BY title ${direction}, id ${direction}`)
	return result.rows.map((row: { id: number }) => row.id)
}

describePg("a sort key too long for a cursor, on Postgres, while every row is there (R8)", () => {
	const sessions = usePg()
	for (const collation of ['"C"', '"default"']) {
		it.each(["title.asc", "title.desc"])(`pages %s exactly, collation ${collation}`, async (order) => {
			await seeded(sessions, collation)
			expect((await pageAll(sessions, order, false)).seen).toEqual(await inOrder(sessions, order))
		})
	}
})

describePg("a sort key too long for a cursor, on Postgres, after its anchor row is deleted (R8)", () => {
	const sessions = usePg()

	it.each(["title.asc", "title.desc"])("resumes %s with no row skipped, collation C", async (order) => {
		await seeded(sessions, '"C"')
		const all = await inOrder(sessions, order)
		const { deleted, seen } = await pageAll(sessions, order, true)
		expect(deleted).toHaveLength(1)
		expect(all.filter((id) => !seen.includes(id))).toEqual([])
	})

	it.each(["title.asc", "title.desc"])(
		"ends %s without an error under a collation not by code point",
		async (order) => {
			await seeded(sessions, '"default"')
			const all = await inOrder(sessions, order)
			const { deleted, seen } = await pageAll(sessions, order, true)
			expect(deleted).toHaveLength(1)
			/* what it served is in order and repeats nothing; it may stop short */
			expect(seen).toEqual(all.filter((id) => seen.includes(id)))
			expect(new Set(seen).size).toBe(seen.length)
		},
	)
})
