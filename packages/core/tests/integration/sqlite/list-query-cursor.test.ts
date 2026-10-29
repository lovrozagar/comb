/**
 * Cursor pagination against SQLite: the tiebreak id keeps its JSON type, so an id with no
 * column affinity still compares as a number, and a cursor is refused unless every value in it
 * is one SQLite can compare.
 */
import { defineRelations, sql } from "drizzle-orm"
import { drizzle as drizzleClient } from "drizzle-orm/libsql"
import type { LibSQLDatabase } from "drizzle-orm/libsql"
import { integer, sqliteTable } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import { CombError } from "../../../src/error.ts"
import { encodeCursor, sortSignature } from "../../../src/query/cursor.ts"
import { createCursor } from "../../../src/query/cursor-mint.ts"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import type { SortField } from "../../../src/query/types.ts"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { built as pagedAs } from "../../../src/query/__fixtures__/built.ts"

const open: LibsqlHarness[] = []
afterEach(() => {
	for (const harness of open.splice(0)) harness.close()
})

/* six posts, every one created at the same instant: the order rests on the tiebreak alone */
async function tied(): Promise<LibSQLDatabase> {
	const harness = libsqlMemory()
	open.push(harness)
	await harness.client.execute("CREATE TABLE post (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL)")
	await harness.client.execute(
		"INSERT INTO post (id, created_at) VALUES (1, 7), (2, 7), (3, 7), (4, 7), (5, 7), (6, 7)",
	)
	return harness.db
}

const SORT: SortField[] = [{ direction: "desc", field: "created_at" }]

type Derived = { created_at: number; rid: number }

/** One page of a derived query whose id is an expression, so it has no column affinity */
async function derivedPage(db: LibSQLDatabase, cursor: string | null) {
	const built = buildDerivedListQuery({
		...SEALED,
		idColumn: sql`rid`,
		parsed: { cursor, limit: 2, parsedSort: SORT },
		sortColumns: { created_at: sql`created_at` },
	})
	const rows = await db.all<Derived>(
		sql`with d as (select id + 0 as rid, created_at from post) select rid, created_at from d where ${built.where ?? sql`1`} order by ${sql.join(built.orderBy, sql`, `)} limit ${built.limit}`,
	)
	const page = rows.slice(0, 2)
	const last = page.at(-1)
	return {
		ids: page.map((row) => row.rid),
		next: rows.length > 2 && last ? createCursor({ ...last, id: last.rid }, SORT, SEALED) : null,
	}
}

describe("a derived query's expression id pages forward (Q-H4)", () => {
	it("walks every row once, three pages of two", async () => {
		const db = await tied()
		const pages: number[][] = []
		let cursor: string | null = null
		for (let guard = 0; guard < 5; guard++) {
			const page = await derivedPage(db, cursor)
			pages.push(page.ids)
			cursor = page.next
			if (!cursor) break
		}
		expect(pages).toEqual([
			[6, 5],
			[4, 3],
			[2, 1],
		])
	})
})

/** A cursor minted for SORT whose values and id are whatever the test says */
const crafted = (values: unknown[], id: unknown = "p1") =>
	encodeCursor({ i: id, s: sortSignature(SORT), v: values } as Parameters<typeof encodeCursor>[0], SEALED)

/** The derived list over `cursor`, ordered by SORT, its key a plain expression or one of epoch milliseconds */
const derivedWith = (cursor: string, key: "date" | "plain" = "plain") =>
	buildDerivedListQuery({
		...SEALED,
		idColumn: sql`rid`,
		parsed: { cursor, limit: 2, parsedSort: SORT },
		sortColumns: { created_at: key === "date" ? { sql: sql`created_at`, type: "date" } : sql`created_at` },
	})

describe("a sealed cursor holding values SQLite cannot compare (Q-M3)", () => {
	const invalid = expect.objectContaining({ errorKey: "invalid_cursor", status: 400 })
	const schema = createListQuerySchema({ filter: { title: "string" }, sort: ["created_at"] })

	it.each([
		["an object", [{ x: 1 }]],
		["an invalid date", [{ $date: "nope" }]],
		["an array", [[1, 2]]],
	])("is a 400 when a value is %s, though its shape passes the schema", (_label, values) => {
		expect(schema.safeParse({ cursor: crafted(values), order: "created_at.desc" }).success).toBe(true)
		expect(() => derivedWith(crafted(values))).toThrow(invalid)
	})

	it.each([
		["an object", { x: 1 }],
		["a boolean", true],
		["null", null],
	])("is a 400 when the id is %s", (_label, id) => {
		expect(() => derivedWith(crafted([7], id))).toThrow(invalid)
	})

	it("is a CombError, not a driver's TypeError", () => {
		expect(() => derivedWith(crafted([{ x: 1 }]))).toThrow(CombError)
	})

	it("accepts a numeric id, a string id, dates and null sort values", () => {
		for (const [values, id] of [
			[[7], 5],
			[[7], "post_5"],
			[[null], 5],
		] as const) {
			expect(() => derivedWith(crafted([...values], id))).not.toThrow()
		}
		expect(() => derivedWith(crafted([{ $date: 1700000000000 }], 5), "date")).not.toThrow()
	})
})

describe("paginate mints a cursor for every last row, whatever its id (Q-M6)", () => {
	it("mints one when the last id is 0 or an empty string", () => {
		for (const id of [0, ""]) {
			const rows = [
				{ created_at: 2, id },
				{ created_at: 1, id: "next" },
			]
			const [, pagination] = queryHelpers.paginate(rows, pagedAs({ limit: 1, parsedSort: SORT }, SEALED))
			expect(pagination.hasMore).toBe(true)
			expect(pagination.nextCursor).not.toBeNull()
		}
	})
})

describe("pagination.count (Q-M5)", () => {
	const post = sqliteTable("post", { created_at: integer("created_at").notNull(), id: integer("id").primaryKey() })
	const schema = createListQuerySchema({ filter: { id: "number" }, sort: ["created_at"] })

	/** One page through the documented path: countExtra in the select, paginate on the rows */
	async function page(params: Record<string, string>) {
		const db = await tied()
		const parsed = schema.parse({ limit: "2", order: "created_at.desc", ...params })
		const built = buildListQuery({ ...SEALED, parsed, table: post })
		const query = db
			.select({ created_at: post.created_at, id: post.id, ...queryHelpers.countExtra(parsed) })
			.from(post)
			.$dynamic()
		const statement = applyListQuery(query, built)
		const rows = await statement
		const [, pagination] = queryHelpers.paginate(rows, pagedAs(parsed, SEALED))
		return { pagination, sql: statement.toSQL().sql.toLowerCase() }
	}

	it("is every row the filter matches on an offset page", async () => {
		expect((await page({})).pagination.count).toBe(6)
		expect((await page({ filter: "id.gt.2", page: "2" })).pagination.count).toBe(4)
	})

	it("is 0 on an empty first page and null on an empty later one", async () => {
		expect((await page({ filter: "id.gt.99" })).pagination.count).toBe(0)
		expect((await page({ page: "9" })).pagination.count).toBeNull()
	})

	it("is null on a cursor page, whose query selects no window count", async () => {
		const first = await page({})
		const next = await page({ cursor: first.pagination.nextCursor as string })
		expect(next.pagination.count).toBeNull()
		expect(next.sql).not.toMatch(/\bover\s*\(/)
		expect(first.sql).toMatch(/\bover\s*\(/)
	})

	it("is null when the query did not select the count", () => {
		const [, pagination] = queryHelpers.paginate([{ id: 1 }], pagedAs({ limit: 2, parsedSort: SORT }, SEALED))
		expect(pagination.count).toBeNull()
	})
})

describe("queryHelpers.listOptions pages the relational API by cursor (Q-L4)", () => {
	const post = sqliteTable("post", { created_at: integer("created_at").notNull(), id: integer("id").primaryKey() })
	const schema = createListQuerySchema({ sort: ["created_at"] })

	async function walk(limit: string): Promise<number[][]> {
		const harness = libsqlMemory()
		open.push(harness)
		const db = drizzleClient({ client: harness.client, relations: defineRelations({ post }, () => ({})) })
		await harness.client.execute("CREATE TABLE post (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL)")
		await harness.client.execute("INSERT INTO post VALUES (1, 7), (2, 7), (3, 9), (4, 7), (5, 9)")
		const pages: number[][] = []
		let cursor: string | null = null
		for (let guard = 0; guard < 6 && (pages.length === 0 || cursor); guard++) {
			const parsed = schema.parse({ limit, order: "created_at.desc", ...(cursor ? { cursor } : {}) })
			const options = queryHelpers.listOptions(parsed, SEALED)
			const rows = await db.query.post.findMany({
				limit: options.limit,
				offset: options.offset,
				orderBy: options.orderBy,
				...(options.where ? { where: options.where } : {}),
			})
			const [items, pagination] = queryHelpers.paginate(rows, pagedAs(parsed, SEALED))
			pages.push(items.map((row) => row.id))
			cursor = pagination.nextCursor
		}
		return pages
	}

	it("walks every row once, in sort order with the id breaking ties", async () => {
		expect(await walk("2")).toEqual([[5, 3], [4, 2], [1]])
	})

	it("refuses a cursor minted under another order", () => {
		/* a caller that skips the schema: listOptions checks the cursor itself */
		const parsed = {
			...schema.parse({ order: "created_at.desc" }),
			cursor: encodeCursor({ i: 1, s: "id.asc.nullslast", v: [1] }, SEALED),
		}
		expect(() => queryHelpers.listOptions(parsed, SEALED)).toThrow(CombError)
	})
})
