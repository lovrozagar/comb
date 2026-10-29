/**
 * A sort key too long for a cursor, on D1 (R8, U2): the cursor carries the row's id, a prefix and
 * the value's length, and the keyset reads the value from the row while it keeps both. A row
 * renamed between pages resumes where its old value stood; a deleted one resumes from the prefix.
 */
import { drizzle } from "drizzle-orm/d1"
import { defineRelations, getTableColumns } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { type D1Harness, d1Memory } from "../support/d1.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { built } from "../../../src/query/__fixtures__/built.ts"

const doc = sqliteTable("doc", { id: integer("id").primaryKey(), title: text("title").notNull() })
const schema = createListQuerySchema({ sort: ["title"], pagination: { defaultLimit: 1, maxLimit: 1 } })
const LONG = "𠀀".repeat(2000)
const TITLES: Array<[number, string]> = [
	[1, `${LONG}b`],
	[2, "a"],
	[3, `${LONG}a`],
	[4, `${LONG}c`],
	[5, "zz"],
	[6, `${LONG}a`],
]

let harness: D1Harness | undefined
afterEach(async () => {
	await harness?.dispose()
	harness = undefined
})

type Page = (order: string, cursor: string | undefined) => Promise<{ ids: number[]; next: string | null }>

async function seeded(): Promise<{ d1: D1Harness["CORE"]; pages: Record<"buildListQuery" | "listOptions", Page> }> {
	harness = await d1Memory()
	const d1 = harness.CORE
	await d1.prepare("CREATE TABLE doc (id INTEGER PRIMARY KEY, title TEXT NOT NULL)").run()
	for (const [id, title] of TITLES) await d1.prepare("INSERT INTO doc VALUES (?, ?)").bind(id, title).run()
	const db = drizzle(d1)
	const relational = drizzle(d1, { relations: defineRelations({ doc }) })
	return {
		d1,
		pages: {
			buildListQuery: async (order, cursor) => {
				const parsed = schema.parse({ cursor, order })
				const rows = await applyListQuery(
					(extras) => db.select({ ...getTableColumns(doc), ...extras }).from(doc),
					buildListQuery({ ...SEALED, parsed, table: doc }),
				)
				const [items, meta] = queryHelpers.paginate(rows, built(parsed, SEALED))
				return { ids: items.map((row) => row.id), next: meta.nextCursor }
			},
			listOptions: async (order, cursor) => {
				const query = { ...schema.parse({ order }), cursor }
				const rows = await relational.query.doc.findMany(queryHelpers.listOptions(query, SEALED) as never)
				const [items, meta] = queryHelpers.paginate(rows as Array<{ id: number }>, built(query, SEALED))
				return { ids: items.map((row) => row.id), next: meta.nextCursor }
			},
		},
	}
}

/** The ids after `title` and `id` under `order`, in the table as it is now */
async function after(d1: D1Harness["CORE"], order: string, [id, title]: [number, string]): Promise<number[]> {
	const [cmp, direction] = order.endsWith("desc") ? ["<", "DESC"] : [">", "ASC"]
	const rows = await d1
		.prepare(
			`SELECT id FROM doc WHERE title ${cmp} ?1 OR (title = ?1 AND id ${cmp} ?2) ORDER BY title ${direction}, id ${direction}`,
		)
		.bind(title, id)
		.all<{ id: number }>()
	return rows.results.map((row) => row.id)
}

describe("a sort key too long for a cursor, its row renamed between pages, on D1 (U2)", () => {
	for (const via of ["buildListQuery", "listOptions"] as const) {
		it.each(["title.asc", "title.desc"])(`resumes %s through ${via} where the old title stood`, async (order) => {
			const { d1, pages } = await seeded()
			const seen: number[] = []
			let expected: number[] | undefined
			let cursor: string | undefined
			for (let guard = 0; guard < 20 && (guard === 0 || cursor !== undefined); guard++) {
				const { ids, next } = await pages[via](order, cursor)
				seen.push(...ids)
				cursor = next ?? undefined
				const last = ids.at(-1) as number
				const title = TITLES.find(([id]) => id === last)?.[1] as string
				if (cursor !== undefined && expected === undefined && title.length > 100) {
					await d1.prepare("UPDATE doc SET title = 'a-renamed' WHERE id = ?").bind(last).run()
					expected = [...seen, ...(await after(d1, order, [last, title]))]
				}
			}
			expect(expected).toBeDefined()
			expect(seen).toEqual(expected)
		})
	}
})
