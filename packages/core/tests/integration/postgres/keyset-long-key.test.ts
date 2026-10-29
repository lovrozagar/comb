/**
 * A sort key too long for a cursor on Postgres (R8): the cursor carries the row's id and a prefix,
 * and the keyset reads the value from the row. Exact while the row is there. Once it is deleted, a
 * column sorted by code point (C or POSIX) resumes from the prefix, repeating rows that share it and
 * skipping none; under any other collation neither prefix bound is safe, so the next page answers
 * invalid_cursor, where it ended the list silently (U26): the client starts it again. A row
 * renamed between pages is a row whose value no longer has the cursor's prefix and length: it
 * resumes as a deleted one does.
 */
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { CombError } from "../../../src/error.ts"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { buildDerivedListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { usePg } from "../support/pg.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { built as pagedAs } from "../../../src/query/__fixtures__/built.ts"

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
): Promise<{ deleted: number[]; refused?: CombError; seen: number[] }> {
	const client = sessions.pg()
	const db = drizzle({ client, relations: defineRelations({ doc }) })
	const seen: number[] = []
	const deleted: number[] = []
	let cursor: string | undefined
	for (let guard = 0; guard < 30; guard++) {
		const query = { ...schema.parse({ order }), cursor }
		const rows = await db.query.doc.findMany(queryHelpers.listOptions(query, SEALED) as never)
		let paged: ReturnType<typeof queryHelpers.paginate<{ id: number; title: string }>>
		try {
			paged = queryHelpers.paginate(rows as Array<{ id: number; title: string }>, pagedAs(query, SEALED))
		} catch (error) {
			if (error instanceof CombError) return { deleted, refused: error, seen }
			throw error
		}
		const [items, meta] = paged
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
		"answers invalid_cursor for %s under a collation not by code point, where it ended silently (U26)",
		async (order) => {
			await seeded(sessions, ICU)
			const all = await inOrder(sessions, order)
			const { deleted, refused, seen } = await pageAll(sessions, order, DELETE)
			expect(deleted).toHaveLength(1)
			expect(seen).toEqual(through(all, deleted[0] as number))
			expect(refused?.errorKey).toBe("invalid_cursor")
		},
	)

	/* U3 of the 0.12 round: a NULL bound must not let the NULL rows through */
	it.each(["title.asc", "title.desc", "title.asc.nullsfirst", "title.desc.nullslast"])(
		"answers invalid_cursor for %s at a deleted anchor on a nullable column, serving none of the NULLs past it",
		async (order) => {
			await seeded(sessions, ICU, ["b", `${LONG}m`, `${LONG}n`, `${LONG}o`, null, null])
			const all = await inOrderBy(sessions, order)
			const { deleted, refused, seen } = await pageAll(sessions, order, DELETE)
			expect(deleted).toHaveLength(1)
			expect(seen).toEqual(through(all, deleted[0] as number))
			expect(refused?.errorKey).toBe("invalid_cursor")
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
		"answers invalid_cursor for %s at the renamed anchor under a collation not by code point (U26)",
		async (order) => {
			await seeded(sessions, ICU)
			const all = await inOrder(sessions, order)
			const { deleted, refused, seen } = await pageAll(sessions, order, RENAME)
			expect(deleted).toHaveLength(1)
			expect(seen).toEqual(through(all, deleted[0] as number))
			expect(refused?.errorKey).toBe("invalid_cursor")
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

/* U26: the anchor's flag reads the anchor row alone, so Postgres evaluates it once a query, never once a row */
describe("the gone-anchor flag on Postgres (U26)", () => {
	const sessions = usePg()

	it("plans as one InitPlan, not a subquery per row", async () => {
		/* every title long, so page 1's anchor goes by reference */
		await seeded(sessions, ICU, [`${LONG}a`, `${LONG}b`, `${LONG}c`])
		const client = sessions.pg()
		const db = drizzle({ client, relations: defineRelations({ doc }) })
		const first = schema.parse({ order: "title.asc" })
		const page = queryHelpers.paginate(
			(await db.query.doc.findMany(queryHelpers.listOptions(first, SEALED) as never)) as Array<{
				id: number
				title: string
			}>,
			pagedAs(first, SEALED),
		)
		const query = { ...first, cursor: page[1].nextCursor as string }
		const built = db.query.doc.findMany(queryHelpers.listOptions(query, SEALED) as never).toSQL()
		const plan = await client.query(`EXPLAIN ${built.sql}`, built.params as unknown[])
		const lines = plan.rows.map((row: Record<string, string>) => Object.values(row)[0]).join("\n")
		expect(lines).toMatch(/InitPlan|\$0/)
		expect(lines).not.toMatch(/SubPlan/)
	})
})

/* Q3 of r17: every builder's rows carry the gone-anchor flag its cursor needs, and a page that lacks it is refused */
describe("a gone anchor on Postgres, whatever builds the list (Q3)", () => {
	const sessions = usePg()
	const LONG_A = "a".repeat(9000)

	it("answers invalid_cursor on an anchored derived list's next page, where it started the list again", async () => {
		await seeded(sessions, ICU, [`${LONG_A}1`, `${LONG_A}2`, "b", "c"])
		const db = drizzle({ client: sessions.pg() })
		const page = async (cursor?: string) => {
			const built = buildDerivedListQuery({
				...SEALED,
				anchor: { idColumn: doc.id as never, table: doc as never },
				parsed: { cursor, limit: 2, parsedSort: [{ direction: "asc", field: "title" }], validated: true },
				sortColumns: { title: doc.title },
			})
			const query = db.select({ id: doc.id, title: doc.title, ...built.extras }).from(doc)
			const rows = await (built.where === undefined ? query : query.where(built.where))
				.orderBy(...built.orderBy)
				.limit(built.limit)
				.offset(built.offset)
			return queryHelpers.paginate(rows, built)
		}
		const [items, meta] = await page()
		expect(items.map((row) => row.id)).toEqual([1, 2])
		await sessions.pg().query("DELETE FROM doc WHERE id = 2")
		await expect(page(meta.nextCursor as string)).rejects.toThrow(
			expect.objectContaining({ errorKey: "invalid_cursor", status: 400 }),
		)
	})

	it("refuses a listOptions page whose rows lack the flag, rather than read it as there", async () => {
		await seeded(sessions, ICU, [`${LONG_A}1`, `${LONG_A}2`, "b", "c"])
		const db = drizzle({ client: sessions.pg(), relations: defineRelations({ doc }) })
		const first = queryHelpers.listOptions({ ...schema.parse({ order: "title.asc" }), limit: 2 }, SEALED)
		const [, meta] = queryHelpers.paginate(await db.query.doc.findMany(first as never), first)
		const next = queryHelpers.listOptions(
			{ ...schema.parse({ order: "title.asc" }), cursor: meta.nextCursor as string, limit: 2 },
			SEALED,
		)
		const { _combAnchorGone, ...without } = next.extras
		expect(_combAnchorGone).toBeTypeOf("function")
		const rows = await db.query.doc.findMany({ ...next, extras: without } as never)
		expect(() => queryHelpers.paginate(rows, next)).toThrow(
			expect.objectContaining({ cause: expect.stringContaining("_combAnchorGone"), errorKey: "page_not_wired" }),
		)
	})
})
