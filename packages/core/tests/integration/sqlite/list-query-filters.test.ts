/**
 * Filters from the request string to the rows SQLite returns. Each value binds as the type its
 * field declares, and every condition the schema accepts reaches the WHERE clause or is refused.
 */
import { sql } from "drizzle-orm"
import type { LibSQLDatabase } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import { CombError } from "../../../src/error.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import type { ComputedFilterResolver } from "../../../src/query/types.ts"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"

const post = sqliteTable("post", {
	created_at: integer("created_at").notNull(),
	id: integer("id").primaryKey(),
	minute_read: integer("minute_read"),
	published: integer("published", { mode: "boolean" }).notNull(),
	title: text("title"),
})

/* [id, title, published, minute_read]; created_at is 1000 * id */
const SEED: Array<[number, string | null, boolean, number | null]> = [
	[1, "Intro", true, 3],
	[2, "Draft", false, 12],
	[3, "Deep dive", true, 25],
	[4, null, false, null],
	[5, "Notes", true, 9],
	[6, "Wip", false, 10],
]

const schema = createListQuerySchema({
	filter: {
		"@score": "number",
		created_at: "date",
		minute_read: "number",
		published: "boolean",
		title: "string",
	},
	sort: ["created_at", "id"],
})

const open: LibsqlHarness[] = []
afterEach(() => {
	for (const harness of open.splice(0)) harness.close()
})

async function seeded(): Promise<LibSQLDatabase> {
	const harness = libsqlMemory()
	open.push(harness)
	await harness.client.execute(
		"CREATE TABLE post (id INTEGER PRIMARY KEY, title TEXT, published INTEGER NOT NULL, minute_read INTEGER, created_at INTEGER NOT NULL)",
	)
	await harness.client.batch(
		SEED.map(([id, title, published, minuteRead]) => ({
			args: [id, title, published ? 1 : 0, minuteRead, id * 1000],
			sql: "INSERT INTO post (id, title, published, minute_read, created_at) VALUES (?, ?, ?, ?, ?)",
		})),
	)
	return harness.db
}

const score: ComputedFilterResolver = (operator, value) =>
	operator === "gt" ? sql`(${post.minute_read} * 1) > ${value}` : null

/** The ids a filter selects, ascending */
async function ids(filter: string, computedFilters = { "@score": score }): Promise<number[]> {
	const db = await seeded()
	const parsed = schema.parse({ filter, limit: "100", order: "id.asc" })
	const query = buildListQuery({ computedFilters, parsed, table: post })
	const rows = await applyListQuery(db.select({ id: post.id }).from(post).$dynamic(), query)
	return rows.map((row) => row.id)
}

const refused = (filter: string) => schema.safeParse({ filter }).success === false

describe("filter values bind as their declared type (Q-H1, Q-M1)", () => {
	it("compares a boolean column with a boolean, not a truthy string", async () => {
		expect(await ids("published.eq.false")).toEqual([2, 4, 6])
		expect(await ids("published.ne.false")).toEqual([1, 3, 5])
		expect(await ids("published.eq.true")).toEqual([1, 3, 5])
	})

	it("hands a computed resolver the number its field declares", async () => {
		expect(await ids("@score.gt.9")).toEqual([2, 3, 6])
	})

	it("compares numbers and dates as numbers", async () => {
		expect(await ids("minute_read.gt.9")).toEqual([2, 3, 6])
		expect(await ids("created_at.gte.5000")).toEqual([5, 6])
	})
})

describe("is (Q-H2)", () => {
	it("compiles null, notnull, true and false, in any case", async () => {
		expect(await ids("title.is.null")).toEqual([4])
		expect(await ids("title.is.NULL")).toEqual([4])
		expect(await ids("title.is.notnull")).toEqual([1, 2, 3, 5, 6])
		expect(await ids("published.is.true")).toEqual([1, 3, 5])
		expect(await ids("published.is.false")).toEqual([2, 4, 6])
	})

	it("refuses any other value, and true or false on a field that is not boolean", () => {
		expect(refused("title.is.maybe")).toBe(true)
		expect(refused("title.is.true")).toBe(true)
		expect(refused("minute_read.is.false")).toBe(true)
	})
})

describe("declared fields the query cannot resolve fail closed (Q-H3)", () => {
	it("throws for a computed field with no resolver instead of returning every row", async () => {
		await expect(ids("@score.gt.9", {} as { "@score": ComputedFilterResolver })).rejects.toThrow(CombError)
	})

	it("throws for a relation field with no relation configured", async () => {
		const relational = createListQuerySchema({ filter: { "author.name": "string" }, sort: ["id"] })
		const parsed = relational.parse({ filter: "author.name.eq.zzz" })
		expect(() => buildListQuery({ parsed, table: post })).toThrow(CombError)
	})

	it("throws when a resolver declines the operator it was given", async () => {
		const declining = createListQuerySchema({ filter: { "@score": "number" }, sort: ["id"] })
		const parsed = declining.parse({ filter: "@score.lt.9" })
		expect(() => buildListQuery({ computedFilters: { "@score": score }, parsed, table: post })).toThrow(CombError)
	})
})

describe("values that do not fit the declared type are refused (Q-M4)", () => {
	it.each([
		"minute_read.lt.abc",
		"minute_read.eq.",
		"minute_read.in.(1,x)",
		"created_at.lt.2024-01-01",
		"published.eq.yes",
		"published.eq.1",
	])("%s is a 400", (filter) => {
		expect(refused(filter)).toBe(true)
	})

	it("keeps an empty string for a string field", async () => {
		expect(refused("title.eq.")).toBe(false)
	})
})
