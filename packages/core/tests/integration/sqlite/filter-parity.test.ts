/**
 * Q5 of r17: buildFilterSQL, which lowers a filter onto a table alias's columns by name, and
 * filterToSQL, which lowers it onto drizzle's columns, are one lowering. Every operator a field
 * takes, on every kind of column, answers the same rows through both.
 */
import { sql } from "drizzle-orm"
import { integer, numeric, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type FilterField, validateFilter } from "../../../src/query/filter-validate.ts"
import { filterToSQL } from "../../../src/query/sqlite/executor.ts"
import { buildFilterSQL, type FilterSQLConfig } from "../../../src/query/sqlite/filter-sql.ts"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"

const p = sqliteTable("p", {
	at_ms: integer("at_ms", { mode: "timestamp_ms" }),
	at_s: integer("at_s", { mode: "timestamp" }),
	flag: integer("flag", { mode: "boolean" }),
	id: integer("id").primaryKey(),
	iso: text("iso"),
	n: integer("n"),
	name: text("name"),
	price: numeric("price"),
	tags: text("tags"),
})

/* 2024-01-01, 2024-06-01T00:00:00.500Z (between two seconds), 2025-01-01, and none */
const [JAN, JUNE, NEXT] = [Date.UTC(2024, 0, 1), Date.UTC(2024, 5, 1) + 500, Date.UTC(2025, 0, 1)]
const ROWS: Array<
	[
		number,
		number | null,
		number | null,
		number | null,
		string | null,
		number | null,
		string | null,
		string | null,
		string | null,
	]
> = [
	[1, JAN, JAN / 1000, 1, "2024-01-01T00:00:00.000Z", 1, "alpha", "1.5", '["a","b"]'],
	[2, JUNE, Math.floor(JUNE / 1000), 0, "2024-06-01T00:00:00.500Z", 2, "beta", "10", '["c"]'],
	[3, NEXT, NEXT / 1000, 1, "2025-01-01T00:00:00.000Z", 3, "Gamma", "2", "[]"],
	[4, null, null, null, null, null, null, null, null],
]

const FIELDS: Record<string, FilterField> = {
	at_ms: { format: "iso", type: "date" },
	at_s: { format: "iso", type: "date" },
	flag: "boolean",
	iso: { format: "iso", type: "date" },
	n: { operators: ["eq", "ne", "neq", "gt", "gte", "lt", "lte", "in", "nin", "is", "contains"], type: "number" },
	name: "string",
	price: "number",
	tags: { operators: ["contains"], type: "string" },
}

const RAW: FilterSQLConfig = {
	columnMap: {
		at_ms: { column: "at_ms", kind: "date-ms" },
		at_s: { column: "at_s", kind: "date-s" },
		flag: { column: "flag", kind: "number" },
		iso: { column: "iso", kind: "text" },
		n: { column: "n", kind: "number" },
		name: { column: "name", kind: "text" },
		price: { column: "price", kind: "number" },
		tags: { column: "tags", kind: "text" },
	},
	tableAlias: "p",
}

const DATES = ["2024-01-01", "2024-06-01T00:00:00.500Z", "2024-06-01", "2025-01-01T00:00+01:00"]
const FILTERS = [
	...["at_ms", "at_s", "iso"].flatMap((field) => [
		...["eq", "ne", "gt", "gte", "lt", "lte"].flatMap((op) => DATES.map((date) => `${field}.${op}.${date}`)),
		`${field}.is.null`,
		`${field}.is.notnull`,
	]),
	...["eq.2", "ne.2", "gt.1", "gte.2", "lt.3", "lte.2", "in.(1,3)", "nin.(1)", "is.null", "contains.2"].map(
		(f) => `n.${f}`,
	),
	...["eq.10", "gt.2", "lt.10", "in.(2,10)"].map((f) => `price.${f}`),
	...["eq.alpha", "ne.alpha", "in.(alpha,beta)", "nin.(alpha)", "like.al*", "ilike.*MA", "is.null"].map(
		(f) => `name.${f}`,
	),
	"flag.is.true",
	"flag.is.false",
	"flag.eq.true",
	"tags.contains.a",
	"tags.contains.z",
]

let harness: LibsqlHarness
beforeAll(async () => {
	harness = libsqlMemory()
	await harness.client.execute(
		"CREATE TABLE p (id INTEGER PRIMARY KEY, at_ms INTEGER, at_s INTEGER, flag INTEGER, iso TEXT, n INTEGER, name TEXT, price NUMERIC, tags TEXT)",
	)
	for (const row of ROWS)
		await harness.client.execute({ args: row, sql: "INSERT INTO p VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)" })
})
afterAll(() => harness.close())

/** The ids `where` keeps, in id order */
async function ids(where: ReturnType<typeof sql>): Promise<number[]> {
	const rows = await harness.db.all<{ id: number }>(sql`SELECT id FROM p AS p WHERE ${where} ORDER BY id`)
	return rows.map((row) => row.id)
}

describe("buildFilterSQL and filterToSQL, one lowering (Q5)", () => {
	it.each(FILTERS)("answer the same rows for %s", async (filter) => {
		const checked = validateFilter(filter, FIELDS)
		if (!checked?.valid) throw new Error(`${filter}: ${JSON.stringify(checked?.errors)}`)
		const drizzleRows = await ids(filterToSQL(checked.ast, { mainTable: p }) as ReturnType<typeof sql>)
		expect(await ids(buildFilterSQL(checked.ast.root, RAW))).toEqual(drizzleRows)
	})
})
