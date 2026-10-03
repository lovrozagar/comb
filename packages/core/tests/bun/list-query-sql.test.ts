/**
 * The list-query layer against a real SQLite engine. Pattern semantics, null
 * placement and keyset pagination are properties of the SQL SQLite runs, so
 * they are asserted on rows, not on generated text.
 */
import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { asc, sql } from "drizzle-orm"
import { drizzle as bunDrizzle } from "drizzle-orm/bun-sqlite"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createCursor, decodeCursor } from "../../src/query/cursor.ts"
import { drizzle } from "../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../src/query/sqlite/build-list-query.ts"
import type { SortField } from "../../src/query/types.ts"

const item = sqliteTable("item", {
	amount: integer("amount"),
	created_at: integer("created_at").notNull(),
	id: text("id").primaryKey(),
	vendor: text("vendor").notNull(),
})

type Item = typeof item.$inferSelect

const SEED: Array<[string, string, number | null]> = [
	["i01", "A", 10],
	["i02", "A", 5],
	["i03", "A", 20],
	["i04", "A", null],
	["i05", "B", 1],
	["i06", "B", null],
	["i07", "acme", 7],
	["i08", "ACME", 8],
	["i09", "C", 3],
	["i10", "Žena", 4],
]

function open() {
	const sqlite = new Database(":memory:")
	sqlite.run(
		"CREATE TABLE item (id TEXT PRIMARY KEY, vendor TEXT NOT NULL, amount INTEGER, created_at INTEGER NOT NULL)",
	)
	SEED.forEach(([id, vendor, amount], index) => {
		sqlite.run("INSERT INTO item (id, vendor, amount, created_at) VALUES (?, ?, ?, ?)", [id, vendor, amount, index])
	})
	return bunDrizzle({ client: sqlite })
}

const schema = createListQuerySchema({
	filter: { amount: "number", vendor: "string" },
	sort: ["created_at", "amount", "vendor"],
})

const label = (row: Pick<Item, "amount" | "vendor">) => `${row.vendor}:${row.amount}`

function listTable(db: ReturnType<typeof open>, query: Record<string, string>) {
	const parsed = schema.parse(query)
	const built = buildListQuery({ parsed, table: item })
	const rows = applyListQuery(db.select().from(item).$dynamic(), built).all()
	const [items, pagination] = drizzle.paginate(rows, parsed)
	return { items: items.map(label), nextCursor: pagination.nextCursor }
}

function listDerived(db: ReturnType<typeof open>, parsedSort: SortField<"amount" | "vendor">[], cursor?: string) {
	const built = buildDerivedListQuery({
		idColumn: item.id,
		parsed: { cursor, limit: 2, parsedSort },
		sortColumns: { amount: item.amount, vendor: item.vendor },
	})
	const query = db.select().from(item).$dynamic()
	const rows = (built.where ? query.where(built.where) : query)
		.orderBy(...built.orderBy)
		.limit(built.limit)
		.offset(built.offset)
		.all()
	const hasMore = rows.length > 2
	const page = hasMore ? rows.slice(0, 2) : rows
	const last = page.at(-1)
	return {
		items: page.map(label),
		nextCursor: hasMore && last ? createCursor(last, parsedSort) : null,
	}
}

function walkTable(db: ReturnType<typeof open>, order: string) {
	const seen: string[] = []
	let cursor: string | null = null
	for (let guard = 0; guard < 20; guard++) {
		const page = listTable(db, { limit: "2", order, ...(cursor ? { cursor } : {}) })
		seen.push(...page.items)
		cursor = page.nextCursor
		if (!cursor) break
	}
	return seen
}

function walkDerived(db: ReturnType<typeof open>, parsedSort: SortField<"amount" | "vendor">[]) {
	const seen: string[] = []
	let cursor: string | undefined
	for (let guard = 0; guard < 20; guard++) {
		const page = listDerived(db, parsedSort, cursor)
		seen.push(...page.items)
		cursor = page.nextCursor ?? undefined
		if (!cursor) break
	}
	return seen
}

describe("like / ilike", () => {
	it("like matches case-sensitively, ilike ignores ASCII case", () => {
		const db = open()
		expect(listTable(db, { filter: "vendor.like.acme", limit: "50" }).items).toEqual(["acme:7"])
		expect(listTable(db, { filter: "vendor.ilike.acme", limit: "50" }).items.sort()).toEqual(["ACME:8", "acme:7"])
	})

	it("like keeps * as the wildcard and treats ? and [ as literals", () => {
		const sqlite = new Database(":memory:")
		sqlite.run(
			"CREATE TABLE item (id TEXT PRIMARY KEY, vendor TEXT NOT NULL, amount INTEGER, created_at INTEGER NOT NULL)",
		)
		const names = ["a?c", "abc", "[x]", "x", "a*c"]
		names.forEach((name, index) => {
			sqlite.run("INSERT INTO item (id, vendor, amount, created_at) VALUES (?, ?, 0, ?)", [`r${index}`, name, index])
		})
		const db = bunDrizzle({ client: sqlite })
		const vendors = (filter: string) =>
			listTable(db, { filter, limit: "50" })
				.items.map((entry) => entry.split(":")[0])
				.sort()
		expect(vendors("vendor.like.a?c")).toEqual(["a?c"])
		expect(vendors("vendor.like.[x]")).toEqual(["[x]"])
		expect(vendors("vendor.like.a*c")).toEqual(["a*c", "a?c", "abc"])
	})
})

describe("null placement", () => {
	it("buildListQuery defaults to nulls last ascending and first descending", () => {
		const db = open()
		expect(
			listTable(db, { limit: "50", order: "amount.asc" })
				.items.slice(-2)
				.every((entry) => entry.endsWith(":null")),
		).toBe(true)
		expect(
			listTable(db, { limit: "50", order: "amount.desc" })
				.items.slice(0, 2)
				.every((entry) => entry.endsWith(":null")),
		).toBe(true)
	})

	it("buildListQuery honors explicit nullsfirst / nullslast", () => {
		const db = open()
		const descLast = listTable(db, { limit: "50", order: "amount.desc.nullslast" }).items
		expect(descLast.slice(-2).every((entry) => entry.endsWith(":null"))).toBe(true)
		const ascFirst = listTable(db, { limit: "50", order: "amount.asc.nullsfirst" }).items
		expect(ascFirst.slice(0, 2).every((entry) => entry.endsWith(":null"))).toBe(true)
	})

	it("buildDerivedListQuery honors explicit nullsfirst / nullslast", () => {
		const db = open()
		const descLast = walkDerived(db, [{ direction: "desc", field: "amount", nulls: "last" }])
		expect(descLast.slice(-2).every((entry) => entry.endsWith(":null"))).toBe(true)
		const ascFirst = walkDerived(db, [{ direction: "asc", field: "amount", nulls: "first" }])
		expect(ascFirst.slice(0, 2).every((entry) => entry.endsWith(":null"))).toBe(true)
	})
})

describe("keyset pagination returns every row exactly once, in order", () => {
	const orders = [
		"amount.asc",
		"amount.desc",
		"amount.asc.nullsfirst",
		"amount.desc.nullslast",
		"vendor.asc,amount.desc",
		"vendor.desc,amount.asc.nullsfirst",
		"vendor.asc",
	]

	for (const order of orders) {
		it(`buildListQuery order=${order}`, () => {
			const db = open()
			const full = listTable(db, { limit: "50", order }).items
			expect(full).toHaveLength(SEED.length)
			expect(walkTable(db, order)).toEqual(full)
		})
	}

	it("buildDerivedListQuery over a multi-key sort with ties and nulls", () => {
		const db = open()
		const parsedSort: SortField<"amount" | "vendor">[] = [
			{ direction: "asc", field: "vendor" },
			{ direction: "desc", field: "amount" },
		]
		const one = db
			.select()
			.from(item)
			.orderBy(asc(item.vendor), sql`${item.amount} DESC NULLS FIRST`, asc(item.id))
			.all()
			.map(label)
		expect(walkDerived(db, parsedSort)).toEqual(one)
	})

	it("a cursor carries non-ASCII sort values", () => {
		const sort: SortField[] = [{ direction: "asc", field: "vendor" }]
		const cursor = createCursor({ id: "i10", vendor: "Žena" }, sort)
		expect(decodeCursor(cursor)?.values).toEqual(["Žena"])
	})

	it("a cursor minted for one order is rejected under another", () => {
		const db = open()
		const first = listTable(db, { limit: "2", order: "amount.asc" })
		expect(first.nextCursor).not.toBeNull()
		expect(() => schema.parse({ cursor: first.nextCursor!, limit: "2", order: "vendor.asc" })).toThrow()
	})
})
