/**
 * AB2 of area B: a list sorted by a drizzle `customType` column, which drizzle gives dataType
 * `custom`, served page 1 and minted a cursor the next request answered `invalid_cursor`, a 400, on
 * the table, the derived and the merged list alike, as the fit check knew no `custom` family. A
 * custom column's value is what its `fromDriver` read, opaque to comb, so a cursor carries it and
 * binds it back through `toDriver`: each list pages every row once. One key is citext-like text, the
 * other a number its mapper scales, so a bound that skipped `toDriver` would compare the wrong value.
 * Ids are out of key order.
 */
import { createClient } from "@libsql/client"
import { getTableColumns } from "drizzle-orm"
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql"
import { customType, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { paginateMerged } from "../../../src/query/merged.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"

/* text compared case-blind, as a citext column is */
const folded = customType<{ data: string; driverData: string }>({
	dataType: () => "text collate nocase",
	fromDriver: (value) => value,
	toDriver: (value) => value,
})
/* a length the database holds in whole units and the app in tenths, integers both ways */
const tenths = customType<{ data: number; driverData: number }>({
	dataType: () => "integer",
	fromDriver: (value) => value * 10,
	toDriver: (value) => value / 10,
})

const item = sqliteTable("custom_item", { id: text("id").primaryKey(), name: folded("name"), price: tenths("price") })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["name", "price"] })
const CREATE = "CREATE TABLE custom_item (id TEXT PRIMARY KEY, name TEXT COLLATE NOCASE, price INTEGER)"
/* name order, case-blind and binary alike, as a merge compares in JS: apple < banana < cherry < date; price order: 150 < 200 < 1000 < 2500 */
const ROWS = [
	["d", "apple", 1000],
	["a", "banana", 150],
	["c", "cherry", 2500],
	["b", "date", 200],
] as const
const SERVED = {
	"name.asc": ["d", "a", "c", "b"],
	"name.desc": ["b", "c", "a", "d"],
	"price.asc": ["a", "b", "d", "c"],
	"price.desc": ["c", "d", "b", "a"],
} as const
type Path = "derived" | "merged" | "table"

/** One database holding `rows` */
async function holding(rows: readonly (readonly [string, string, number])[]): Promise<LibSQLDatabase> {
	const client = createClient({ url: ":memory:" })
	await client.execute(CREATE)
	for (const [id, name, price] of rows)
		await client.execute({ args: [id, name, price], sql: "INSERT INTO custom_item VALUES (?, ?, ?)" })
	return drizzle({ client })
}

/** Every id `path` serves by `order`, one a page, by cursor, at most eight pages */
async function served(path: Path, order: keyof typeof SERVED): Promise<string[]> {
	/* the merged list's rows sit on two shards, two each */
	const dbs =
		path === "merged" ? [await holding(ROWS.slice(0, 2)), await holding(ROWS.slice(2))] : [await holding(ROWS)]
	const ids: string[] = []
	let cursor: string | undefined
	for (let n = 1; n <= 8; n++) {
		const parsed = { ...schema.parse({ order }), cursor }
		const select = (db: LibSQLDatabase) => (extras: object) =>
			db.select({ ...getTableColumns(item), ...extras }).from(item)
		let page: Record<string, unknown>[]
		let next: string | null
		if (path === "merged") {
			const list = buildListQuery({ ...SEALED, merged: {}, parsed, table: item })
			const reads = await Promise.all(dbs.map((db) => applyListQuery(select(db), list)))
			const [items, meta] = paginateMerged(reads, list)
			;[page, next] = [items, meta.nextCursor]
		} else {
			const list =
				path === "table"
					? buildListQuery({ ...SEALED, parsed, table: item })
					: buildDerivedListQuery({
							...SEALED,
							idColumn: item.id,
							parsed,
							sortColumns: { name: item.name, price: item.price },
						})
			const rows = await applyListQuery(select(dbs[0] as LibSQLDatabase), list)
			const [items, meta] = queryHelpers.paginate(rows, list)
			;[page, next] = [items, meta.nextCursor]
		}
		ids.push(...page.map((row) => row["id"] as string))
		if (next === null) return ids
		cursor = next
	}
	return ids
}

describe("a customType key pages or is refused at the mint (AB2 of area B; sibling: QL5's blob)", () => {
	it.each(["table", "derived", "merged"] as const)(
		"pages a customType key on the %s list every row once, asc and desc",
		async (path) => {
			for (const order of Object.keys(SERVED) as (keyof typeof SERVED)[])
				expect(await served(path, order), order).toEqual(SERVED[order])
		},
	)
})
