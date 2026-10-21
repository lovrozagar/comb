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

describe("an empty group is the identity of its logic (Q-D1)", () => {
	it("matches nothing for an empty or() and everything for an empty and(), alone and nested", async () => {
		expect(await ids("or()")).toEqual([])
		expect(await ids("and(published.eq.true,or())")).toEqual([])
		expect(await ids("or(published.eq.false,or())")).toEqual([2, 4, 6])
		expect(await ids("and()")).toEqual([1, 2, 3, 4, 5, 6])
		expect(await ids("or(published.eq.false,and())")).toEqual([1, 2, 3, 4, 5, 6])
		expect(await ids("and(published.eq.true,and())")).toEqual([1, 3, 5])
	})
})

describe("a number or date the request cannot carry exactly is a 400 (Q-D2, Q-D3)", () => {
	it.each([
		"minute_read.eq.9007199254740993",
		"minute_read.in.(1,-9007199254740992)",
		"minute_read.gt.1e400",
		"created_at.gt.100000000000000000000",
		"created_at.lt.-8640000000000001",
	])("%s is a 400", (filter) => {
		expect(refused(filter)).toBe(true)
	})

	it.each([
		"minute_read.eq.9007199254740991",
		"minute_read.lt.-9007199254740991",
		"minute_read.gt.1.5e300",
		"created_at.lt.8640000000000000",
	])("%s is accepted", (filter) => {
		expect(refused(filter)).toBe(false)
	})
})

/* post → post_tag → tag, the join table with an id of its own, so a guessed key would join the wrong column */
const tag = sqliteTable("tag", { id: integer("id").primaryKey(), slug: text("slug") })
const postTag = sqliteTable("post_tag", {
	id: integer("id").primaryKey(),
	post_id: integer("post_id"),
	tag_id: integer("tag_id"),
})
const tagged = createListQuerySchema({ filter: { "tags.slug": "string" }, sort: ["id"] })

/** The ids `filter` selects through the tags relation, ascending */
async function taggedIds(filter: string, relation: Record<string, unknown>): Promise<number[]> {
	const db = await seeded()
	const harness = open.at(-1) as LibsqlHarness
	await harness.client.executeMultiple(`CREATE TABLE tag (id INTEGER PRIMARY KEY, slug TEXT);
CREATE TABLE post_tag (id INTEGER PRIMARY KEY, post_id INTEGER, tag_id INTEGER);
INSERT INTO tag VALUES (10, 'release'), (20, 'draft');
INSERT INTO post_tag VALUES (1, 3, 10), (2, 5, 10), (3, 1, 20);`)
	const parsed = tagged.parse({ filter, limit: "100", order: "id.asc" })
	const relations = { tags: relation as never }
	const query = buildListQuery({ parsed, relations, table: post })
	const rows = await applyListQuery(db.select({ id: post.id }).from(post).$dynamic(), query)
	return rows.map((row) => row.id)
}

describe("relation filters run against the join table's own keys (B1)", () => {
	const relation = {
		target: tag,
		targetKey: "id",
		through: postTag,
		throughSourceKey: "post_id",
		throughTargetKey: "tag_id",
	}

	it("selects the rows whose related row matches", async () => {
		expect(await taggedIds("tags.slug.eq.release", relation)).toEqual([3, 5])
		expect(await taggedIds("tags.slug.eq.draft", relation)).toEqual([1])
	})

	it("refuses a relation whose key names no column, instead of joining a guess", async () => {
		const wrong = { ...relation, throughTargetKey: "tagId" }
		await expect(taggedIds("tags.slug.eq.release", wrong)).rejects.toMatchObject({ errorKey: "filter_not_wired" })
	})
})

/* a seconds column (mode: "timestamp"), a milliseconds one, and an ISO date kept as text */
const event = sqliteTable("event", {
	at_ms: integer("at_ms", { mode: "timestamp_ms" }),
	at_s: integer("at_s", { mode: "timestamp" }),
	day: text("day"),
	id: integer("id").primaryKey(),
})
const events = createListQuerySchema({ filter: { at_ms: "date", at_s: "date", day: "date" }, sort: ["id"] })

/** The ids `filter` selects from events at 1 s, 5 s and 9 s */
async function eventIds(filter: string): Promise<number[]> {
	const harness = libsqlMemory()
	open.push(harness)
	await harness.client
		.executeMultiple(`CREATE TABLE event (id INTEGER PRIMARY KEY, at_s INTEGER, at_ms INTEGER, day TEXT);
INSERT INTO event VALUES (1, 1, 1000, '1970-01-01'), (2, 5, 5000, '1970-01-01'), (3, 9, 9000, '1970-01-01');`)
	const parsed = events.parse({ filter, limit: "100", order: "id.asc" })
	const query = buildListQuery({ parsed, table: event })
	const rows = await applyListQuery(harness.db.select({ id: event.id }).from(event).$dynamic(), query)
	return rows.map((row) => row.id)
}

describe("date filters bind in the unit their column stores (B4)", () => {
	it("compares epoch milliseconds with a seconds column and a milliseconds one alike", async () => {
		expect(await eventIds("at_s.gt.2000")).toEqual([2, 3])
		expect(await eventIds("at_ms.gt.2000")).toEqual([2, 3])
		expect(await eventIds("at_s.lte.5000")).toEqual([1, 2])
	})

	it("refuses a date filter wired to a text column, which would compare text with a number", async () => {
		await expect(eventIds("day.gt.2000")).rejects.toMatchObject({ errorKey: "filter_not_wired" })
	})
})

/* item ← link → item: a relation back to the main table itself */
const item = sqliteTable("item", { id: integer("id").primaryKey(), name: text("name").notNull() })
const link = sqliteTable("link", { from_id: integer("from_id").notNull(), to_id: integer("to_id").notNull() })
const linked = createListQuerySchema({ filter: { name: "string", "related.name": "string" }, sort: ["id"] })

describe("a relation back to the main table reads the outer row's key (Q-D8)", () => {
	it("finds the items linked to beta, and none for an item nothing links", async () => {
		const harness = libsqlMemory()
		open.push(harness)
		await harness.client.executeMultiple(`CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE link (from_id INTEGER NOT NULL, to_id INTEGER NOT NULL);
INSERT INTO item VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma');
INSERT INTO link VALUES (1, 2), (3, 1);`)
		const related = {
			target: item,
			targetKey: "id",
			through: link,
			throughSourceKey: "from_id",
			throughTargetKey: "to_id",
		}
		const names = async (filter: string) => {
			const parsed = linked.parse({ filter, limit: "100", order: "id.asc" })
			const query = buildListQuery({ parsed, relations: { related }, table: item })
			return (await applyListQuery(harness.db.select({ name: item.name }).from(item).$dynamic(), query)).map(
				(r) => r.name,
			)
		}
		expect(await names("related.name.eq.beta")).toEqual(["alpha"])
		expect(await names("related.name.eq.alpha")).toEqual(["gamma"])
		expect(await names("and(name.eq.alpha,related.name.eq.gamma)")).toEqual([])
	})
})
