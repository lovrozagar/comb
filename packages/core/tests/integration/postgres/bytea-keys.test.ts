/**
 * QL5 of r22b on Postgres: a list sorted by a `bytea` column minted a cursor the next request
 * answered `invalid_cursor`, as the codec wrote the row's Buffer as a JSON object its decoder
 * refuses. The cursor now carries the bytes under a `$bytes` tag and binds them as bytea, so each
 * path pages every row once in Postgres's byte order. Ids are out of key order, and one value is a
 * prefix of another.
 *
 * B2-5 of area B, its sibling on the expression path: a list sorted by an SQL expression over a
 * `bytea` reads the key as the Buffer each driver reads a bytea as, and the next page refused the
 * cursor carrying it as `invalid_cursor`, anchored or not, on node-postgres and postgres.js alike.
 */
import { defineRelations, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import { bytea, type PgAsyncDatabase, type PgQueryResultHKT, pgTable, text } from "drizzle-orm/pg-core"
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
const SEED = `CREATE TEMP TABLE IF NOT EXISTS bytea_item (id text PRIMARY KEY, b bytea);
	DELETE FROM bytea_item;
	INSERT INTO bytea_item VALUES ('d', '\\x00'), ('a', '\\x0001'), ('c', '\\x01'), ('b', '\\xff')`

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
	await client.query(SEED)
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

/** Every id the anchored or the anchorless list over `db` serves by an expression over `b`, one a page, at most eight pages */
async function servedByExpression(
	db: PgAsyncDatabase<PgQueryResultHKT>,
	shape: "anchored" | "anchorless",
	direction: "asc" | "desc",
): Promise<string[]> {
	const key = sql`${item.b}`
	const ids: string[] = []
	let cursor: string | undefined
	for (let n = 1; n <= 8; n++) {
		const built = buildDerivedListQuery({
			...SEALED,
			...(shape === "anchored" ? { anchor: { idColumn: item.id, table: item } } : { idColumn: item.id }),
			parsed: { ...schema.parse({ order: `b.${direction}` }), cursor },
			sortColumns: { b: key },
		})
		const select = db
			.select({ b: key, id: item.id, ...built.extras })
			.from(item)
			.$dynamic()
		const rows = await (built.where === undefined ? select : select.where(built.where))
			.orderBy(...built.orderBy)
			.limit(built.limit)
		const [items, meta] = queryHelpers.paginate(rows, built)
		ids.push(...items.map((row) => row.id))
		if (meta.nextCursor === null) return ids
		cursor = meta.nextCursor
	}
	return ids
}

describe("an expression over bytea pages by its bytes, on both drivers (B2-5 of area B; sibling: QL5's column)", () => {
	const sessions = usePg()

	it.each([
		["node-postgres", async () => (await sessions.pg().query(SEED), drizzle({ client: sessions.pg() }))],
		["postgres.js", async () => (await sessions.sql().unsafe(SEED), drizzlePostgres({ client: sessions.sql() }))],
	] as Array<[string, () => Promise<PgAsyncDatabase<PgQueryResultHKT>>]>)(
		"pages an anchored and an anchorless list on %s every row once, asc and desc",
		async (_, open) => {
			const db = await open()
			for (const shape of ["anchored", "anchorless"] as const)
				for (const direction of ["asc", "desc"] as const)
					expect(await servedByExpression(db, shape, direction), `${shape} ${direction}`).toEqual(SERVED[direction])
		},
	)
})
