/**
 * AB2 of area B on Postgres: a list sorted by a drizzle `customType` column minted a cursor the next
 * request answered `invalid_cursor`, a 400, as the fit check knew no `custom` family. The column here
 * is a domain over numeric its mapper reads as a JS number, and the four values agree past a double's
 * digits, so every one reads as 0.1: the list carries the key's text, as it does an expression over
 * numeric, and each path pages every row once, with the cursor's row kept or deleted before the next
 * page. Ids are out of key order.
 */
import { drizzle } from "drizzle-orm/node-postgres"
import { customType, pgTable, text } from "drizzle-orm/pg-core"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { usePg } from "../support/pg.ts"

/* a numeric domain the app reads as a JS number, the rounding QL3 carries the text for */
const amount = customType<{ data: number; driverData: string }>({
	dataType: () => "pg_temp.amount",
	fromDriver: (value) => Number(value),
	toDriver: (value) => value.toFixed(20),
})

const item = pgTable("custom_item", { a: amount("a"), id: text("id").primaryKey() })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["a"] })
const SERVED = { asc: ["d", "a", "c", "b"], desc: ["b", "c", "a", "d"] } as const
type Path = "anchored" | "anchorless" | "table"

/** The session's domain and table, holding the four rows afresh */
async function seed(client: pg.Client): Promise<void> {
	const [made] = (await client.query("SELECT to_regclass('pg_temp.custom_item') AS t")).rows
	if (made?.t === null)
		await client.query(`CREATE DOMAIN pg_temp.amount AS numeric;
		CREATE TEMP TABLE custom_item (id text PRIMARY KEY, a pg_temp.amount)`)
	await client.query(`DELETE FROM custom_item;
	INSERT INTO custom_item VALUES ('d', 0.1000000000000000001), ('a', 0.1000000000000000002),
		('c', 0.1000000000000000003), ('b', 0.1000000000000000004)`)
}

/** The list `path` builds for `query` */
function listOf(path: Path, query: ReturnType<typeof schema.parse>) {
	if (path === "table") return buildListQuery({ ...SEALED, parsed: query, table: item as never })
	const anchor = path === "anchored" ? { anchor: { idColumn: item.id, table: item } } : { idColumn: item.id }
	return buildDerivedListQuery({ ...SEALED, ...anchor, parsed: query, sortColumns: { a: item.a } })
}

/** Every id `path` serves by `a`, one a page, by cursor, deleting each page's rows when `deleting` */
async function served(
	client: pg.Client,
	path: Path,
	{ deleting, direction }: { deleting: boolean; direction: "asc" | "desc" },
) {
	await seed(client)
	const ids: string[] = []
	let cursor: string | undefined
	for (let n = 1; n <= 8; n++) {
		const query = { ...schema.parse({ order: `a.${direction}` }), cursor }
		const built = listOf(path, query)
		const select = drizzle({ client })
			.select({ a: item.a, id: item.id, ...built.extras })
			.from(item)
			.$dynamic()
		const rows = await (built.where === undefined ? select : select.where(built.where))
			.orderBy(...built.orderBy)
			.limit(built.limit)
		const [items, meta] = queryHelpers.paginate(rows, built)
		const page = items.map((row) => row["id"] as string)
		ids.push(...page)
		if (deleting) await client.query("DELETE FROM custom_item WHERE id = ANY($1)", [page])
		if (meta.nextCursor === null) return ids
		cursor = meta.nextCursor
	}
	return ids
}

describe("a customType key pages or is refused at the mint, on Postgres (AB2 of area B; sibling: QL5's bytea)", () => {
	const sessions = usePg()

	it.each(["table", "anchored", "anchorless"] as const)(
		"pages a customType key over a numeric domain on the %s list every row once, its cursor row there or deleted",
		async (path) => {
			for (const deleting of [false, true])
				for (const direction of ["asc", "desc"] as const)
					expect(await served(sessions.pg(), path, { deleting, direction }), `${direction} ${deleting}`).toEqual(
						SERVED[direction],
					)
		},
	)
})
