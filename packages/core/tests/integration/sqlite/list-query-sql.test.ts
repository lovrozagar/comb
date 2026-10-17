/**
 * The list-query layer against a real SQLite engine. Pattern semantics, null
 * placement and keyset pagination are properties of the SQL SQLite runs, so
 * they are asserted on rows, not on generated text.
 */
import { asc, sql } from "drizzle-orm"
import type { LibSQLDatabase } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import { createCursor, decodeCursor } from "../../../src/query/cursor.ts"
import { drizzle } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import type { SortField } from "../../../src/query/types.ts"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"

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

const CREATE =
	"CREATE TABLE item (id TEXT PRIMARY KEY, vendor TEXT NOT NULL, amount INTEGER, created_at INTEGER NOT NULL)"

const open: LibsqlHarness[] = []

afterEach(() => {
	for (const harness of open.splice(0)) harness.close()
})

/** A fresh database holding `rows`, as [id, vendor, amount]. */
async function seeded(rows: Array<[string, string, number | null]> = SEED): Promise<LibSQLDatabase> {
	const harness = libsqlMemory()
	open.push(harness)
	await harness.client.execute(CREATE)
	await harness.client.batch(
		rows.map(([id, vendor, amount], index) => ({
			args: [id, vendor, amount, index],
			sql: "INSERT INTO item (id, vendor, amount, created_at) VALUES (?, ?, ?, ?)",
		})),
	)
	return harness.db
}

const schema = createListQuerySchema({
	filter: { amount: "number", vendor: "string" },
	sort: ["created_at", "amount", "vendor"],
})

const label = (row: Pick<Item, "amount" | "vendor">) => `${row.vendor}:${row.amount}`

async function listTable(db: LibSQLDatabase, query: Record<string, string>) {
	const parsed = schema.parse(query)
	const built = buildListQuery({ parsed, table: item })
	const rows = await applyListQuery(db.select().from(item).$dynamic(), built)
	const [items, pagination] = drizzle.paginate(rows, parsed)
	return { items: items.map(label), nextCursor: pagination.nextCursor }
}

async function listDerived(db: LibSQLDatabase, parsedSort: SortField<"amount" | "vendor">[], cursor?: string) {
	const built = buildDerivedListQuery({
		idColumn: item.id,
		parsed: { cursor, limit: 2, parsedSort },
		sortColumns: { amount: item.amount, vendor: item.vendor },
	})
	const query = db.select().from(item).$dynamic()
	const rows = await (built.where ? query.where(built.where) : query)
		.orderBy(...built.orderBy)
		.limit(built.limit)
		.offset(built.offset)
	const hasMore = rows.length > 2
	const page = hasMore ? rows.slice(0, 2) : rows
	const last = page.at(-1)
	return {
		items: page.map(label),
		nextCursor: hasMore && last ? createCursor(last, parsedSort) : null,
	}
}

async function walkTable(db: LibSQLDatabase, order: string) {
	const seen: string[] = []
	let cursor: string | null = null
	for (let guard = 0; guard < 20; guard++) {
		const page = await listTable(db, { limit: "2", order, ...(cursor ? { cursor } : {}) })
		seen.push(...page.items)
		cursor = page.nextCursor
		if (!cursor) break
	}
	return seen
}

async function walkDerived(db: LibSQLDatabase, parsedSort: SortField<"amount" | "vendor">[]) {
	const seen: string[] = []
	let cursor: string | undefined
	for (let guard = 0; guard < 20; guard++) {
		const page = await listDerived(db, parsedSort, cursor)
		seen.push(...page.items)
		cursor = page.nextCursor ?? undefined
		if (!cursor) break
	}
	return seen
}

const allNull = (entries: string[]) => entries.every((entry) => entry.endsWith(":null"))

describe("like / ilike", () => {
	it("like matches case-sensitively, ilike ignores ASCII case", async () => {
		const db = await seeded()
		expect((await listTable(db, { filter: "vendor.like.acme", limit: "50" })).items).toEqual(["acme:7"])
		expect((await listTable(db, { filter: "vendor.ilike.acme", limit: "50" })).items.sort()).toEqual([
			"ACME:8",
			"acme:7",
		])
	})

	it("like keeps * as the wildcard and treats ? and [ as literals", async () => {
		const names = ["a?c", "abc", "[x]", "x", "a*c"]
		const db = await seeded(names.map((name, index) => [`r${index}`, name, 0]))
		const vendors = async (filter: string) =>
			(await listTable(db, { filter, limit: "50" })).items.map((entry) => entry.split(":")[0]).sort()
		expect(await vendors("vendor.like.a?c")).toEqual(["a?c"])
		expect(await vendors("vendor.like.[x]")).toEqual(["[x]"])
		expect(await vendors("vendor.like.a*c")).toEqual(["a*c", "a?c", "abc"])
	})
})

describe("null placement", () => {
	it("buildListQuery defaults to nulls last ascending and first descending", async () => {
		const db = await seeded()
		expect(allNull((await listTable(db, { limit: "50", order: "amount.asc" })).items.slice(-2))).toBe(true)
		expect(allNull((await listTable(db, { limit: "50", order: "amount.desc" })).items.slice(0, 2))).toBe(true)
	})

	it("buildListQuery honors explicit nullsfirst / nullslast", async () => {
		const db = await seeded()
		const descLast = (await listTable(db, { limit: "50", order: "amount.desc.nullslast" })).items
		expect(allNull(descLast.slice(-2))).toBe(true)
		const ascFirst = (await listTable(db, { limit: "50", order: "amount.asc.nullsfirst" })).items
		expect(allNull(ascFirst.slice(0, 2))).toBe(true)
	})

	it("buildDerivedListQuery honors explicit nullsfirst / nullslast", async () => {
		const db = await seeded()
		const descLast = await walkDerived(db, [{ direction: "desc", field: "amount", nulls: "last" }])
		expect(allNull(descLast.slice(-2))).toBe(true)
		const ascFirst = await walkDerived(db, [{ direction: "asc", field: "amount", nulls: "first" }])
		expect(allNull(ascFirst.slice(0, 2))).toBe(true)
	})
})

describe("keyset pagination returns every row exactly once, in order", () => {
	it.each([
		"amount.asc",
		"amount.desc",
		"amount.asc.nullsfirst",
		"amount.desc.nullslast",
		"vendor.asc,amount.desc",
		"vendor.desc,amount.asc.nullsfirst",
		"vendor.asc",
	])("buildListQuery order=%s", async (order) => {
		const db = await seeded()
		const full = (await listTable(db, { limit: "50", order })).items
		expect(full).toHaveLength(SEED.length)
		expect(await walkTable(db, order)).toEqual(full)
	})

	it("buildDerivedListQuery over a multi-key sort with ties and nulls", async () => {
		const db = await seeded()
		const parsedSort: SortField<"amount" | "vendor">[] = [
			{ direction: "asc", field: "vendor" },
			{ direction: "desc", field: "amount" },
		]
		const one = (
			await db
				.select()
				.from(item)
				.orderBy(asc(item.vendor), sql`${item.amount} DESC NULLS FIRST`, asc(item.id))
		).map(label)
		expect(await walkDerived(db, parsedSort)).toEqual(one)
	})

	it("a cursor carries non-ASCII sort values", () => {
		const sort: SortField[] = [{ direction: "asc", field: "vendor" }]
		const cursor = createCursor({ id: "i10", vendor: "Žena" }, sort)
		expect(decodeCursor(cursor)?.values).toEqual(["Žena"])
	})

	it("a cursor minted for one order is rejected under another", async () => {
		const db = await seeded()
		const first = await listTable(db, { limit: "2", order: "amount.asc" })
		expect(first.nextCursor).not.toBeNull()
		expect(() => schema.parse({ cursor: first.nextCursor!, limit: "2", order: "vendor.asc" })).toThrow()
	})
})
