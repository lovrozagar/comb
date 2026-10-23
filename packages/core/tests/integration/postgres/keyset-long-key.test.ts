/**
 * A sort key too long for a cursor on Postgres (R8): the cursor carries the row's id and a prefix,
 * and the keyset reads the value from the row. Exact while the row is there. Once it is deleted, a
 * column sorted by code point (C or POSIX) resumes from the prefix, repeating rows that share it and
 * skipping none; under any other collation neither prefix bound is safe, and the list ends. A row
 * renamed between pages is a row whose value no longer has the cursor's prefix and length: it
 * resumes as a deleted one does.
 */
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { usePg } from "../support/pg.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

const doc = pgTable("doc", { id: integer("id").primaryKey(), title: text("title").notNull() })
const schema = createListQuerySchema({ sort: ["title"], pagination: { defaultLimit: 1, maxLimit: 1 } })
const LONG = "長".repeat(3000)
/* a collation that does not sort by code point; "default" is C on a database initialized under C */
const ICU = '"en-US-x-icu"'
const ROWS = [`${LONG}b`, "a", `${LONG}a`, `${LONG}c`, "zz", `${LONG}a`, "長"]

type Sessions = ReturnType<typeof usePg>

async function seeded(sessions: Sessions, collation: string, rows: ReadonlyArray<string | null> = ROWS) {
	const client = sessions.pg()
	const notNull = rows.includes(null) ? "" : "NOT NULL"
	await client.query(`CREATE TEMP TABLE doc (id integer PRIMARY KEY, title text COLLATE ${collation} ${notNull})`)
	for (const [i, title] of rows.entries()) await client.query("INSERT INTO doc VALUES ($1, $2)", [i + 1, title])
}

type Edit = (client: ReturnType<Sessions["pg"]>, id: number) => Promise<void>
const DELETE: Edit = async (client, id) => {
	await client.query("DELETE FROM doc WHERE id = $1", [id])
}
const RENAME: Edit = async (client, id) => {
	await client.query("UPDATE doc SET title = 'a-renamed' WHERE id = $1", [id])
}

/** Every id under `order`, one row a page; `edit` runs on the first long row a page ends on */
async function pageAll(
	sessions: Sessions,
	order: string,
	edit: Edit | false,
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
		const last = items.at(-1) as { id: number; title: string | null }
		if (edit && deleted.length === 0 && (last.title?.length ?? 0) > 100) {
			deleted.push(last.id)
			await edit(client, last.id)
		}
		cursor = meta.nextCursor
	}
	throw new Error(`${order} did not end in 30 pages`)
}

/** The ids in Postgres's own order, NULLs last ascending and first descending as comb orders them */
async function inOrder(sessions: Sessions, order: string): Promise<number[]> {
	const direction = order.endsWith("desc") ? "DESC NULLS FIRST" : "ASC NULLS LAST"
	const result = await sessions.pg().query(`SELECT id FROM doc ORDER BY title ${direction}, id ${direction}`)
	return result.rows.map((row: { id: number }) => row.id)
}

/** The ids `all` lists up to and including `id`: a list that ends at its anchor */
const through = (all: readonly number[], id: number) => all.slice(0, all.indexOf(id) + 1)

describe("a sort key too long for a cursor, on Postgres, while every row is there (R8)", () => {
	const sessions = usePg()
	for (const collation of ['"C"', '"default"', ICU]) {
		it.each(["title.asc", "title.desc"])(`pages %s exactly, collation ${collation}`, async (order) => {
			await seeded(sessions, collation)
			expect((await pageAll(sessions, order, false)).seen).toEqual(await inOrder(sessions, order))
		})
	}
})

describe("a sort key too long for a cursor, on Postgres, after its anchor row is deleted (R8)", () => {
	const sessions = usePg()

	it.each(["title.asc", "title.desc"])("resumes %s with no row skipped, collation C", async (order) => {
		await seeded(sessions, '"C"')
		const all = await inOrder(sessions, order)
		const { deleted, seen } = await pageAll(sessions, order, DELETE)
		expect(deleted).toHaveLength(1)
		expect(all.filter((id) => !seen.includes(id))).toEqual([])
	})

	it.each(["title.asc", "title.desc"])(
		"ends %s without an error under a collation not by code point",
		async (order) => {
			await seeded(sessions, ICU)
			const all = await inOrder(sessions, order)
			const { deleted, seen } = await pageAll(sessions, order, DELETE)
			expect(deleted).toHaveLength(1)
			expect(seen).toEqual(through(all, deleted[0] as number))
		},
	)

	/* U3 of the 0.12 round: a NULL bound must not let the NULL rows through */
	it.each(["title.asc", "title.desc", "title.asc.nullsfirst", "title.desc.nullslast"])(
		"ends %s at a deleted anchor on a nullable column, serving none of the NULLs past it",
		async (order) => {
			await seeded(sessions, ICU, ["b", `${LONG}m`, `${LONG}n`, `${LONG}o`, null, null])
			const all = await inOrderBy(sessions, order)
			const { deleted, seen } = await pageAll(sessions, order, DELETE)
			expect(deleted).toHaveLength(1)
			expect(seen).toEqual(through(all, deleted[0] as number))
		},
	)
})

/* U2 of the 0.12 round: a renamed anchor resumes where its old value stood, or ends where no bound is safe */
describe("a sort key too long for a cursor, on Postgres, after its anchor row is renamed (U2)", () => {
	const sessions = usePg()

	it.each(["title.asc", "title.desc"])("resumes %s where the old title stood, collation C", async (order) => {
		await seeded(sessions, '"C"')
		const client = sessions.pg()
		let rest: number[] = []
		let before: number[] = []
		const { deleted, seen } = await pageAll(sessions, order, async (pg, id) => {
			const old = (await pg.query("SELECT title FROM doc WHERE id = $1", [id])).rows[0].title as string
			before = (await inOrder(sessions, order)).slice(0, (await inOrder(sessions, order)).indexOf(id) + 1)
			await RENAME(pg, id)
			const cmp = order.endsWith("desc") ? "<" : ">"
			const direction = order.endsWith("desc") ? "DESC" : "ASC"
			const after = await client.query(
				`SELECT id FROM doc WHERE title ${cmp} $1 OR (title = $1 AND id ${cmp} $2) ORDER BY title ${direction}, id ${direction}`,
				[old, id],
			)
			rest = after.rows.map((row: { id: number }) => row.id)
		})
		expect(deleted).toHaveLength(1)
		expect(seen).toEqual([...before, ...rest])
	})

	it.each(["title.asc", "title.desc"])(
		"ends %s at the renamed anchor under a collation not by code point",
		async (order) => {
			await seeded(sessions, ICU)
			const all = await inOrder(sessions, order)
			const { deleted, seen } = await pageAll(sessions, order, RENAME)
			expect(deleted).toHaveLength(1)
			expect(seen).toEqual(through(all, deleted[0] as number))
		},
	)
})

/** The ids in Postgres's own order for an order string with its null placement */
async function inOrderBy(sessions: Sessions, order: string): Promise<number[]> {
	const [, direction, nulls] = order.split(".")
	const placement =
		nulls === undefined
			? direction === "asc"
				? "NULLS LAST"
				: "NULLS FIRST"
			: nulls === "nullsfirst"
				? "NULLS FIRST"
				: "NULLS LAST"
	const sort = `${(direction as string).toUpperCase()} ${placement}`
	const result = await sessions
		.pg()
		.query(`SELECT id FROM doc ORDER BY title ${sort}, id ${(direction as string).toUpperCase()}`)
	return result.rows.map((row: { id: number }) => row.id)
}
