/**
 * QL5 of r22b on Postgres: a list sorted by a `bytea` column minted a cursor the next request
 * answered `invalid_cursor`, as the codec wrote the row's Buffer as a JSON object its decoder
 * refuses. The cursor now carries the bytes under a `$bytes` tag and binds them as bytea, so each
 * path pages every row once in Postgres's byte order. Ids are out of key order, and one value is a
 * prefix of another.
 */
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { bytea, pgTable, text } from "drizzle-orm/pg-core"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { built as pagedAs } from "../../../src/query/__fixtures__/built.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { usePg } from "../support/pg.ts"

const item = pgTable("bytea_item", { b: bytea("b"), id: text("id").primaryKey() })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["b"] })
/* byte order: 00 < 00 01 < 01 < ff */
const SERVED = { asc: ["d", "a", "c", "b"], desc: ["b", "c", "a", "d"] } as const
type Path = "derived" | "relational" | "table"

/** One page of `path` after the query's cursor: its rows and what paginate reads them by */
async function pageOf(
	client: pg.Client,
	path: Path,
	query: ReturnType<typeof schema.parse>,
): Promise<[Record<string, unknown>[], Parameters<typeof queryHelpers.paginate>[1]]> {
	if (path === "relational") {
		const db = drizzle({ client, relations: defineRelations({ item }) })
		const rows = await db.query.item.findMany(queryHelpers.listOptions(query, SEALED) as never)
		return [rows as Record<string, unknown>[], pagedAs(query, SEALED)]
	}
	const built =
		path === "table"
			? buildListQuery({ ...SEALED, parsed: query, table: item as never })
			: buildDerivedListQuery({ ...SEALED, idColumn: item.id, parsed: query, sortColumns: { b: item.b } })
	const select = drizzle({ client })
		.select({ b: item.b, id: item.id, ...built.extras })
		.from(item)
		.$dynamic()
	const rows = await (built.where === undefined ? select : select.where(built.where))
		.orderBy(...built.orderBy)
		.limit(built.limit)
	return [rows, built]
}

/** Every id `path` serves by `b`, one a page, by cursor, at most eight pages */
async function served(client: pg.Client, path: Path, direction: "asc" | "desc"): Promise<string[]> {
	await client.query(`CREATE TEMP TABLE IF NOT EXISTS bytea_item (id text PRIMARY KEY, b bytea);
	DELETE FROM bytea_item;
	INSERT INTO bytea_item VALUES ('d', '\\x00'), ('a', '\\x0001'), ('c', '\\x01'), ('b', '\\xff')`)
	const ids: string[] = []
	let cursor: string | undefined
	for (let n = 1; n <= 8; n++) {
		const query = { ...schema.parse({ order: `b.${direction}` }), cursor }
		const [rows, built] = await pageOf(client, path, query)
		const [items, meta] = queryHelpers.paginate(rows, built)
		ids.push(...items.map((row) => row["id"] as string))
		if (meta.nextCursor === null) return ids
		cursor = meta.nextCursor
	}
	return ids
}

describe("a minted cursor is one comb reads, on Postgres (QL5 of r22b; sibling: the SQLite blob walk)", () => {
	const sessions = usePg()

	it.each(["table", "derived", "relational"] as const)(
		"pages a bytea key on the %s path every row once, asc and desc",
		async (path) => {
			for (const direction of ["asc", "desc"] as const)
				expect(await served(sessions.pg(), path, direction), direction).toEqual(SERVED[direction])
		},
	)
})
