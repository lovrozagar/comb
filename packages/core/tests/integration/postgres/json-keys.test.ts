/**
 * AB4-1 of area B: a Postgres jsonb key holding JSON strings minted a cursor its next page
 * refused as invalid_cursor, a 400 for the server's own cursor, as the open holds a JSON column to no
 * value a cursor carries. The mint now runs the open's column check on every row it serves, so the
 * list answers the documented 500 naming the key on page 1, on every path, at every page size.
 */
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { jsonb, pgTable, text } from "drizzle-orm/pg-core"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { usePg } from "../support/pg.ts"

const item = pgTable("json_item", { id: text("id").primaryKey(), k: jsonb("k") })
type Path = "anchorless" | "listOptions" | "table"

/** What a walk of `path` ended on: its error's key and status, and the ids served before it */
type Ended = { error: string | null; ids: string[] }

/** Every id `path` serves of a jsonb key holding "a", "b" and "c", `limit` a page ascending, by cursor, at most five pages */
async function walked(client: pg.Client, path: Path, limit: number): Promise<Ended> {
	await client.query(`CREATE TEMP TABLE IF NOT EXISTS json_item (id text PRIMARY KEY, k jsonb);
	DELETE FROM json_item;
	INSERT INTO json_item VALUES ('r0', '"a"'), ('r1', '"b"'), ('r2', '"c"')`)
	const schema = createListQuerySchema({ pagination: { defaultLimit: limit, maxLimit: limit }, sort: ["k"] })
	const ids: string[] = []
	let cursor: string | undefined
	try {
		for (let n = 1; n <= 5; n++) {
			const query = { ...schema.parse({ order: "k.asc" }), cursor }
			const [rows, meta] = await pageOf(client, path, query)
			ids.push(...rows.map((row) => row["id"] as string))
			if (meta.nextCursor === null) return { error: null, ids }
			cursor = meta.nextCursor
		}
	} catch (error) {
		const { cause, errorKey, status } = error as { cause?: string; errorKey?: string; status?: number }
		return { error: `${errorKey} ${status}${String(cause).includes("sort by k") ? " naming k" : ""}`, ids }
	}
	return { error: "no end", ids }
}

/** One page of `path` after the query's cursor, paginated */
async function pageOf(client: pg.Client, path: Path, query: Parameters<typeof queryHelpers.listOptions>[0]) {
	if (path === "listOptions") {
		const options = queryHelpers.listOptions(query, SEALED)
		const db = drizzle({ client, relations: defineRelations({ item }) })
		return queryHelpers.paginate((await db.query.item.findMany(options as never)) as Record<string, unknown>[], options)
	}
	const built =
		path === "table"
			? buildListQuery({ ...SEALED, parsed: query, table: item as never })
			: buildDerivedListQuery({ ...SEALED, idColumn: item.id, parsed: query, sortColumns: { k: item.k } })
	const select = drizzle({ client })
		.select({ id: item.id, k: item.k, ...built.extras })
		.from(item)
		.$dynamic()
	const rows = await (built.where === undefined ? select : select.where(built.where))
		.orderBy(...built.orderBy)
		.limit(built.limit)
	return queryHelpers.paginate(rows as Record<string, unknown>[], built)
}

describe("a JSON key's cursor is never refused as invalid_cursor (AB4-1 of area B)", () => {
	const sessions = usePg()

	it.each(["table", "anchorless", "listOptions"] as const)(
		"answers a jsonb key on the %s path the 500 naming it on page 1, at limits 1 and 2",
		async (path) => {
			for (const limit of [1, 2])
				expect(await walked(sessions.pg(), path, limit), `limit ${limit}`).toEqual({
					error: "sort_not_wired 500 naming k",
					ids: [],
				})
		},
	)
})
