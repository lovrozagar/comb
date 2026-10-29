/**
 * A sort key too long for a cursor (R8): any client can write a 9000-character title, and the
 * cursor at that row would pass the cap. The cursor then carries the row's id and the longest
 * prefix that fits, and the keyset reads the value from the row itself: exact while the row is
 * there, and, once it is deleted, resumed from the prefix, which may repeat rows and skips none.
 */
import { defineRelations, type SQLWrapper, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { alias, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { libsqlMemory } from "../support/libsql.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { built as pagedAs } from "../../../src/query/__fixtures__/built.ts"

const doc = sqliteTable("doc", { id: integer("id").primaryKey(), title: text("title").notNull() })
const schema = createListQuerySchema({ sort: ["title"], pagination: { defaultLimit: 1, maxLimit: 1 } })
const LONG = "長".repeat(3000)

/* long titles that share their first 3000 characters, short ones around them */
const TITLES: Array<[number, string]> = [
	[1, `${LONG}b`],
	[2, "a"],
	[3, `${LONG}a`],
	[4, `${LONG}c`],
	[5, "zz"],
	[6, `${LONG}a`],
	[7, "長"],
]

type Harness = ReturnType<typeof libsqlMemory>

/* the same, of astral characters (two UTF-16 units each), so a prefix is cut inside a run of them */
const ASTRAL = "𠀀".repeat(2000)
const ASTRAL_TITLES: Array<[number, string]> = TITLES.map(([id, title]) => [id, title.replaceAll(LONG, ASTRAL)])

async function seeded(collate = "", titles = TITLES): Promise<Harness> {
	const harness = libsqlMemory()
	await harness.client.execute(`CREATE TABLE doc (id INTEGER PRIMARY KEY, title TEXT NOT NULL ${collate})`)
	for (const [id, title] of titles)
		await harness.client.execute({ args: [id, title], sql: "INSERT INTO doc VALUES (?, ?)" })
	return harness
}

type Page = (
	harness: Harness,
	order: string,
	cursor: string | undefined,
) => Promise<{ ids: number[]; next: string | null }>

const BUILDER: Page = async (harness, order, cursor) => {
	const parsed = schema.parse({ cursor, order })
	const rows = await applyListQuery(
		harness.db.select().from(doc).$dynamic(),
		buildListQuery({ ...SEALED, parsed, table: doc }),
	)
	const [items, meta] = queryHelpers.paginate(rows, pagedAs(parsed, SEALED))
	return { ids: items.map((row) => row.id), next: meta.nextCursor }
}

const RELATIONAL: Page = async (harness, order, cursor) => {
	const db = drizzle({ client: harness.client, relations: defineRelations({ doc }) })
	const query = { ...schema.parse({ order }), cursor }
	const rows = await db.query.doc.findMany(queryHelpers.listOptions(query, SEALED) as never)
	const [items, meta] = queryHelpers.paginate(rows as Array<{ id: number; title: string }>, pagedAs(query, SEALED))
	return { ids: items.map((row) => row.id), next: meta.nextCursor }
}

/** Every id under `order`, one row a page; `between` runs after each page with the ids so far */
async function pageAll(
	harness: Harness,
	page: Page,
	{ between, order }: { between?: (seen: number[]) => Promise<void>; order: string },
) {
	const seen: number[] = []
	let cursor: string | undefined
	for (let guard = 0; guard < 30; guard++) {
		const { ids, next } = await page(harness, order, cursor)
		seen.push(...ids)
		if (next === null) return seen
		expect(next.length).toBeLessThanOrEqual(8192)
		cursor = next
		await between?.(seen)
	}
	throw new Error(`${order} did not end in 30 pages`)
}

/** The ids in SQLite's own order */
async function inOrder(harness: Harness, order: string): Promise<number[]> {
	const direction = order.endsWith("desc") ? "DESC" : "ASC"
	const rows = await harness.client.execute(`SELECT id FROM doc ORDER BY title ${direction}, id ${direction}`)
	return rows.rows.map((row) => Number(row[0]))
}

describe("a sort key too long for a cursor (R8)", () => {
	for (const [name, page] of [
		["buildListQuery", BUILDER],
		["listOptions", RELATIONAL],
	] as const) {
		it.each(["title.asc", "title.desc"])(`pages %s exactly through ${name} while every row is there`, async (order) => {
			const harness = await seeded()
			try {
				expect(await pageAll(harness, page, { order })).toEqual(await inOrder(harness, order))
			} finally {
				harness.close()
			}
		})

		for (const collate of ["", "COLLATE NOCASE"]) {
			it.each(["title.asc", "title.desc"])(
				`resumes %s through ${name} with no row skipped when the page's last row is deleted ${collate}`,
				async (order) => {
					const harness = await seeded(collate)
					try {
						const all = await inOrder(harness, order)
						const deleted = new Set<number>()
						const seen = await pageAll(harness, page, {
							order,
							between: async (ids) => {
								/* the first long row a page ends on goes away before the next page */
								const last = ids.at(-1) as number
								if (deleted.size === 0 && (TITLES.find(([id]) => id === last)?.[1].length ?? 0) > 100) {
									deleted.add(last)
									await harness.client.execute({ args: [last], sql: "DELETE FROM doc WHERE id = ?" })
								}
							},
						})
						expect(deleted.size).toBe(1)
						expect(all.filter((id) => !seen.includes(id))).toEqual([])
					} finally {
						harness.close()
					}
				},
			)
		}
	}
})

/** The ids after `title` and `id` under `order`, in the table as it is now: where a plain cursor resumes */
async function after(harness: Harness, order: string, [id, title]: [number, string]): Promise<number[]> {
	const [cmp, direction] = order.endsWith("desc") ? ["<", "DESC"] : [">", "ASC"]
	const rows = await harness.client.execute({
		args: [title, title, id],
		sql: `SELECT id FROM doc WHERE title ${cmp} ? OR (title = ? AND id ${cmp} ?) ORDER BY title ${direction}, id ${direction}`,
	})
	return rows.rows.map((row) => Number(row[0]))
}

/* U2 of the 0.12 round: a cursor resumes where its row's value stood when it was minted, as a plain cursor does */
describe("a sort key too long for a cursor, its row renamed between pages (U2)", () => {
	for (const [name, page, titles] of [
		["buildListQuery", BUILDER, TITLES],
		["listOptions", RELATIONAL, TITLES],
		["buildListQuery, astral titles,", BUILDER, ASTRAL_TITLES],
		["listOptions, astral titles,", RELATIONAL, ASTRAL_TITLES],
	] as const) {
		it.each(["title.asc", "title.desc"])(`resumes %s through ${name} where the old title stood`, async (order) => {
			const harness = await seeded("", titles)
			try {
				let anchor: [number, string] | undefined
				let rest: number[] = []
				let before: number[] = []
				const seen = await pageAll(harness, page, {
					order,
					between: async (ids) => {
						const last = ids.at(-1) as number
						const title = titles.find(([id]) => id === last)?.[1] as string
						if (anchor !== undefined || title.length < 100) return
						anchor = [last, title]
						before = [...ids]
						await harness.client.execute({ args: [last], sql: "UPDATE doc SET title = 'a-renamed' WHERE id = ?" })
						rest = await after(harness, order, anchor)
					},
				})
				expect(anchor).toBeDefined()
				expect(seen).toEqual([...before, ...rest])
			} finally {
				harness.close()
			}
		})
	}
})

/** One page of the doc list derived by `label` (title unless given), anchored to doc or keyed by its id alone, `cursor` resuming it */
async function derivedPage(
	harness: Harness,
	anchored: boolean,
	{ cursor, label = doc.title }: { cursor?: string | undefined; label?: SQLWrapper } = {},
) {
	const built = buildDerivedListQuery({
		...SEALED,
		...(anchored ? { anchor: { idColumn: doc.id, table: doc } } : { idColumn: doc.id }),
		parsed: { cursor, limit: 2, parsedSort: [{ direction: "asc" as const, field: "label" }] },
		sortColumns: { label },
	})
	const query = harness.db.select({ id: doc.id, label: doc.title }).from(doc)
	const rows = await (built.where === undefined ? query : query.where(built.where))
		.orderBy(...built.orderBy)
		.limit(built.limit)
	return queryHelpers.paginate(rows, built)
}

/* C3 of the 0.14.1 review: a derived list whose rows are one table pages a long key as that table's own list does */
describe("a derived list's key too long for a cursor (R8, C3)", () => {
	it("pages by reference to the table it names as its anchor, every row once", async () => {
		const harness = await seeded()
		try {
			const seen: number[] = []
			let cursor: string | undefined
			for (let n = 0; n < 6; n++) {
				const [items, meta] = await derivedPage(harness, true, { cursor })
				seen.push(...items.map((row) => row.id))
				if (meta.nextCursor === null) break
				cursor = meta.nextCursor
			}
			expect(seen).toEqual([2, 5, 7, 3, 6, 1, 4])
		} finally {
			harness.close()
		}
	})

	it("refuses on the page that meets the long key, with no anchor to read it back from", async () => {
		const harness = await seeded()
		try {
			const [, first] = await derivedPage(harness, false)
			await expect(derivedPage(harness, false, { cursor: first.nextCursor as string })).rejects.toThrow(
				expect.objectContaining({
					cause: expect.stringMatching(/^a row's label is too long to page this list by: .*derived list reads no row/),
					status: 500,
				}),
			)
		} finally {
			harness.close()
		}
	})

	it("says to give it an anchor when a cursor by reference reaches a derived list with none", async () => {
		const harness = await seeded()
		try {
			const [, first] = await derivedPage(harness, true)
			const [, second] = await derivedPage(harness, true, { cursor: first.nextCursor as string })
			await expect(derivedPage(harness, false, { cursor: second.nextCursor as string })).rejects.toThrow(
				expect.objectContaining({
					cause: expect.stringContaining("give buildDerivedListQuery the table its rows are as anchor"),
					status: 500,
				}),
			)
		} finally {
			harness.close()
		}
	})
})

/** Every id the list pages, `label` its sort, a page's refusal thrown */
async function paged(harness: Harness, label: SQLWrapper): Promise<number[]> {
	const seen: number[] = []
	let cursor: string | undefined
	for (let n = 0; n < 6; n++) {
		const [items, meta] = await derivedPage(harness, true, { cursor, label })
		seen.push(...items.map((row) => row.id))
		if (meta.nextCursor === null) break
		cursor = meta.nextCursor
	}
	return seen
}

/* 27.7 of plan 15: an anchored list sorted by an SQL expression, which the sortColumns type takes */
describe("an anchored derived list sorted by an SQL expression, its key too long for a cursor", () => {
	it("pages by reference when the expression reads the anchor table's own columns alone", async () => {
		const harness = await seeded()
		try {
			expect(await paged(harness, sql`lower(${doc.title})`)).toEqual([2, 5, 7, 3, 6, 1, 4])
		} finally {
			harness.close()
		}
	})

	it("refuses on the page that meets the long key when no reference reads it back, never minting a cursor it refuses", async () => {
		const harness = await seeded()
		try {
			await expect(paged(harness, sql.raw('lower("doc"."title")'))).rejects.toThrow(
				expect.objectContaining({
					cause: expect.stringMatching(
						/^a row's label is too long to page this list by: .*no reference reads its value back/,
					),
					status: 500,
				}),
			)
		} finally {
			harness.close()
		}
	})
})

/*
 * 27.14 of plan 15: a text column of a table joined to the anchor reads no reference back from the
 * anchor's row, so paging by one looped between the first two rows; it is refused instead
 */
describe("an anchored derived list sorted by a joined table's text column, its key too long for a cursor", () => {
	const remark = sqliteTable("remark", { body: text("body").notNull(), doc_id: integer("doc_id").notNull() })

	it("refuses on the page that meets the long key, never minting a cursor that loops", async () => {
		const harness = await seeded()
		try {
			await harness.client.execute("CREATE TABLE remark (doc_id INTEGER NOT NULL, body TEXT NOT NULL)")
			await harness.client.execute("INSERT INTO remark SELECT id, title FROM doc")
			const seen: number[] = []
			let cursor: string | undefined
			const page = async () => {
				const built = buildDerivedListQuery({
					...SEALED,
					anchor: { idColumn: doc.id, table: doc },
					parsed: { cursor, limit: 2, parsedSort: [{ direction: "asc" as const, field: "label" }] },
					sortColumns: { label: remark.body },
				})
				const query = harness.db
					.select({ id: doc.id, label: remark.body })
					.from(doc)
					.innerJoin(remark, sql`${remark.doc_id} = ${doc.id}`)
				const rows = await (built.where === undefined ? query : query.where(built.where))
					.orderBy(...built.orderBy)
					.limit(built.limit)
				return queryHelpers.paginate(rows, built)
			}
			const paging = (async () => {
				for (let n = 0; n < 6; n++) {
					const [items, meta] = await page()
					seen.push(...items.map((row) => row.id))
					if (meta.nextCursor === null) return
					cursor = meta.nextCursor
				}
			})()
			await expect(paging).rejects.toThrow(
				expect.objectContaining({
					cause: expect.stringMatching(
						/^a row's label is too long to page this list by: .*no reference reads its value back/,
					),
					status: 500,
				}),
			)
			/* the pages before the refusal hold every row once */
			expect(new Set(seen).size).toBe(seen.length)
		} finally {
			harness.close()
		}
	})
})

/*
 * 27.19 of plan 15: an anchor that is a drizzle alias pages a long key by reference, as its own
 * columns are its own; another alias of the same table, a self-join, reads none back and is refused
 */
describe("an anchored derived list whose anchor is an alias, its key too long for a cursor", () => {
	const mine = alias(doc, "mine")
	const theirs = alias(doc, "theirs")

	/** Every id a list over `mine` pages, sorted by `label`, its rows `theirs` joined on the id when it sorts by theirs */
	async function aliased(harness: Harness, label: SQLWrapper): Promise<number[]> {
		const seen: number[] = []
		let cursor: string | undefined
		for (let n = 0; n < 6; n++) {
			const built = buildDerivedListQuery({
				...SEALED,
				anchor: { idColumn: mine.id, table: mine },
				parsed: { cursor, limit: 2, parsedSort: [{ direction: "asc" as const, field: "label" }] },
				sortColumns: { label },
			})
			const query = harness.db
				.select({ id: mine.id, label: mine.title })
				.from(mine)
				.innerJoin(theirs, sql`${theirs.id} = ${mine.id}`)
			const rows = await (built.where === undefined ? query : query.where(built.where))
				.orderBy(...built.orderBy)
				.limit(built.limit)
			const [items, meta] = queryHelpers.paginate(rows, built)
			seen.push(...items.map((row) => row.id))
			if (meta.nextCursor === null) break
			cursor = meta.nextCursor
		}
		return seen
	}

	it("pages its own alias's long key by reference, every row once", async () => {
		const harness = await seeded()
		try {
			expect(await aliased(harness, mine.title)).toEqual([2, 5, 7, 3, 6, 1, 4])
		} finally {
			harness.close()
		}
	})

	it("refuses another alias of the same table, naming the key and why", async () => {
		const harness = await seeded()
		try {
			await expect(aliased(harness, theirs.title)).rejects.toThrow(
				expect.objectContaining({
					cause: expect.stringMatching(/^a row's label is too long to page this list by: .*not of the anchor table/),
					status: 500,
				}),
			)
		} finally {
			harness.close()
		}
	})
})
