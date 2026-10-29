/**
 * Q5 and C13 of the 0.14.1 review, on a real libsql database: an ISO date filter matches by the
 * instant it names, however it is spelled, against the form its column stores (`toISOString()`
 * text, epoch milliseconds, a drizzle date in either unit), and `contains` finds a member of a
 * JSON array column.
 */
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type FilterField, validateFilter } from "../../../src/query/filter-validate.ts"
import { filterToSQL } from "../../../src/query/sqlite/executor.ts"

const event = sqliteTable("event", {
	ms: integer("ms").notNull(),
	name: text("name").primaryKey(),
	nums: text("nums", { mode: "json" }),
	/* a plain text column holding a JSON array, or a scalar JSON value (27.8 of plan 15) */
	raw: text("raw"),
	/* the same column, filtered as a date field */
	rawDay: text("raw"),
	seconds: integer("seconds", { mode: "timestamp" }).notNull(),
	stamp: integer("stamp", { mode: "timestamp_ms" }).notNull(),
	tags: text("tags", { mode: "json" }),
	text: text("text").notNull(),
})

const MIDNIGHT = Date.UTC(2024, 0, 1)
const NOON = Date.UTC(2024, 0, 1, 12)

const client = createClient({ url: ":memory:" })
const db = drizzle({ client })

beforeAll(async () => {
	await client.execute(
		"CREATE TABLE event (name TEXT PRIMARY KEY, text TEXT NOT NULL, ms INTEGER NOT NULL, stamp INTEGER NOT NULL, seconds INTEGER NOT NULL, tags TEXT, nums TEXT, raw TEXT)",
	)
	for (const [name, at, tags, nums, raw] of [
		["midnight", MIDNIGHT, '["red","blue"]', "[1,2]", `[2.5,${MIDNIGHT}]`],
		["noon", NOON, '["green"]', "[3]", "2.5"],
	] as const)
		await client.execute({
			args: [name, new Date(at).toISOString(), at, at, at / 1000, tags, nums, raw],
			sql: "INSERT INTO event VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		})
})
afterAll(() => client.close())

const ISO: FilterField = { format: "iso", operators: ["eq", "gte", "lt", "in"], type: "date" }
const FIELDS: Record<string, FilterField> = {
	ms: ISO,
	nums: { operators: ["contains"], type: "number" },
	raw: { operators: ["contains"], type: "number" },
	rawDay: { operators: ["contains"], type: "date" },
	seconds: ISO,
	stamp: ISO,
	tags: { operators: ["contains"], type: "string" },
	text: ISO,
}

/** The rows `filter` matches, validated as a request is, then lowered */
async function matched(filter: string): Promise<string[]> {
	const result = validateFilter(filter, FIELDS)
	if (!result?.valid) throw new Error(`invalid: ${JSON.stringify(result)}`)
	const where = filterToSQL(result.ast, { mainTable: event })
	if (where === null) throw new Error(`not wired: ${filter}`)
	const rows = await db.select({ name: event.name }).from(event).where(where).orderBy(event.name)
	return rows.map((row) => row.name)
}

describe("an ISO date filter, by the instant it names (Q5)", () => {
	it.each(["text", "ms", "stamp", "seconds"])(
		"matches %s by instant, an offset, a bare date and no seconds",
		async (column) => {
			expect(await matched(`${column}.eq.2024-01-01T01:00+01:00`), "offset").toEqual(["midnight"])
			expect(await matched(`${column}.eq.2024-01-01`), "bare date").toEqual(["midnight"])
			expect(await matched(`${column}.gte.2024-01-01T12:00Z`), "no seconds").toEqual(["noon"])
			expect(await matched(`${column}.lt.2024-01-01T06:00:00.001-06:00`), "a millisecond after noon").toEqual([
				"midnight",
				"noon",
			])
			expect(await matched(`${column}.in.(2024-01-01T07:00-05:00,2023-12-31)`), "in").toEqual(["noon"])
			/* a fraction past milliseconds is cut, as toISOString() writes the instant */
			expect(await matched(`${column}.lt.2024-01-01T12:00:00.0009Z`), "a fraction cut").toEqual(["midnight"])
		},
	)
})

describe("contains on a JSON array column (C13)", () => {
	it("finds a row whose array holds the value, typed as the field declares", async () => {
		expect(await matched("tags.contains.red")).toEqual(["midnight"])
		expect(await matched("tags.contains.purple")).toEqual([])
		expect(await matched("nums.contains.3")).toEqual(["noon"])
		expect(await matched("or(tags.contains.green,nums.contains.1)")).toEqual(["midnight", "noon"])
	})

	/* 27.8 of plan 15: a number or a date on a plain text column holding JSON, and a scalar JSON value is no set */
	it("finds a number or a date in a plain text column's JSON array, and none in a scalar JSON value", async () => {
		expect(await matched("raw.contains.2.5")).toEqual(["midnight"])
		expect(await matched(`rawDay.contains.${MIDNIGHT}`)).toEqual(["midnight"])
	})
})
