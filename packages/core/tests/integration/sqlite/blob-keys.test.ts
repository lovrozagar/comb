/**
 * QL5 of r22b: a cursor comb mints must be one comb reads. A list sorted by a BLOB column served page
 * 1 and minted a cursor the next request answered `invalid_cursor`, a 400, on the table, the derived
 * and the merged list alike, as the codec wrote a Uint8Array as a JSON object its decoder refuses. It
 * now carries the bytes under a `$bytes` tag, so each list pages every row once in SQLite's byte
 * order; a key no cursor can carry, a json-mode column's object, is a 500 on page 1. Ids are out of
 * key order, and one blob is a prefix of another.
 */
import { createClient } from "@libsql/client"
import { getTableColumns } from "drizzle-orm"
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql"
import { blob, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { paginateMerged } from "../../../src/query/merged.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"

const item = sqliteTable("blob_item", {
	b: blob("b", { mode: "buffer" }),
	doc: text("doc", { mode: "json" }),
	id: text("id").primaryKey(),
})
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["b", "doc"] })
const CREATE = "CREATE TABLE blob_item (id TEXT PRIMARY KEY, b BLOB, doc TEXT)"
/* byte order: 00 < 00 01 < 01 < ff */
const ROWS = [
	["d", "x'00'"],
	["a", "x'0001'"],
	["c", "x'01'"],
	["b", "x'ff'"],
] as const
const SERVED = { asc: ["d", "a", "c", "b"], desc: ["b", "c", "a", "d"] } as const
type Path = "derived" | "merged" | "table"

/** One database holding `rows`, each with a json doc */
async function holding(rows: readonly (readonly [string, string])[]): Promise<LibSQLDatabase> {
	const client = createClient({ url: ":memory:" })
	await client.execute(CREATE)
	for (const [id, b] of rows) await client.execute(`INSERT INTO blob_item VALUES ('${id}', ${b}, '{"n":1}')`)
	return drizzle({ client })
}

/** Every id `path` serves by `order`, one a page, by cursor, at most eight pages */
async function served(path: Path, order: string): Promise<string[]> {
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
					: buildDerivedListQuery({ ...SEALED, idColumn: item.id, parsed, sortColumns: { b: item.b, doc: item.doc } })
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

describe("a minted cursor is one comb reads (QL5 of r22b; sibling: a cursor openCursor refuses)", () => {
	it.each(["table", "derived", "merged"] as const)(
		"pages a blob key on the %s list every row once, asc and desc",
		async (path) => {
			for (const direction of ["asc", "desc"] as const)
				expect(await served(path, `b.${direction}`), direction).toEqual(SERVED[direction])
		},
	)

	it.each(["table", "derived", "merged"] as const)(
		"refuses a json-mode key on the %s list on page 1, as sort_not_wired naming it",
		async (path) => {
			await expect(served(path, "doc.asc")).rejects.toMatchObject({
				errorKey: "sort_not_wired",
				cause: expect.stringContaining("doc"),
			})
		},
	)
})
