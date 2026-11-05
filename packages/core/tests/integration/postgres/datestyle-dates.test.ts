/**
 * AB3-9 of area B: a Postgres timestamptz key read in drizzle's date mode under DateStyle
 * 'SQL, DMY' reads as an Invalid Date, as ±infinity does. Bounded from its row as an infinity, a
 * finite row resumed the list from the direction's own end, so the table, anchored and listOptions
 * lists served the first row on every page without end. The key's to_json text these lists carry
 * (AB3-4) binds the instant itself instead. Ids are out of key order; each walk serves one row a
 * page, on node-postgres and postgres.js, and again deleting each page's rows before the next.
 */
import { defineRelations, eq, getTableColumns, type SQL, sql } from "drizzle-orm"
import { drizzle as nodeDrizzle } from "drizzle-orm/node-postgres"
import { type PgAsyncDatabase, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { drizzle as jsDrizzle } from "drizzle-orm/postgres-js"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { usePg } from "../support/pg.ts"

const post = pgTable("ds_date_post", {
	id: text("id").primaryKey(),
	k: timestamp("k", { precision: 6, withTimezone: true }),
})
const metric = pgTable("ds_date_metric", {
	k: timestamp("k", { precision: 6, withTimezone: true }),
	post_id: text("post_id"),
})
const RELATIONS = defineRelations({ post })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["k"] })

const SEED = `
	SET DateStyle = 'SQL, DMY'; SET TimeZone = 'Asia/Kolkata';
	CREATE TEMP TABLE ds_date_post (id text PRIMARY KEY, k timestamptz(6));
	CREATE TEMP TABLE ds_date_metric (post_id text, k timestamptz(6));
	INSERT INTO ds_date_post VALUES ('c', '2024-01-01 00:00:00+00'), ('a', '2024-01-01 02:00:00+00'), ('b', '2024-01-01 06:00:00+00');
	INSERT INTO ds_date_metric SELECT id, k FROM ds_date_post`
const SERVED = { asc: ["c", "a", "b"], desc: ["b", "a", "c"] } as const
const KINDS = ["table", "anchored own", "anchored joined", "anchorless", "expression", "listOptions"] as const

type Db = PgAsyncDatabase<any, any>
type Parsed = ReturnType<typeof schema.parse>

/** One page of the list `kind` builds for `parsed`, and its next cursor */
async function pageOf(db: Db, kind: (typeof KINDS)[number], parsed: Parsed): Promise<[string[], string | null]> {
	if (kind === "listOptions") {
		const options = queryHelpers.listOptions(parsed, SEALED)
		const relational = db as unknown as { query: { post: { findMany: (o: never) => Promise<{ id: string }[]> } } }
		const [items, meta] = queryHelpers.paginate(await relational.query.post.findMany(options as never), options)
		return [items.map((row) => row.id), meta.nextCursor]
	}
	const key: SQL | typeof post.k | typeof metric.k =
		kind === "anchored joined" ? metric.k : kind === "expression" ? sql`${post.k}` : post.k
	const sortColumns = { k: key }
	const list =
		kind === "table"
			? buildListQuery({ ...SEALED, parsed, table: post })
			: kind === "anchorless" || kind === "expression"
				? buildDerivedListQuery({ ...SEALED, idColumn: post.id, parsed, sortColumns })
				: buildDerivedListQuery({ ...SEALED, anchor: { idColumn: post.id, table: post }, parsed, sortColumns })
	const rows = await applyListQuery(
		(extras) =>
			db
				.select({ ...getTableColumns(post), k: key, ...extras })
				.from(post)
				.innerJoin(metric, eq(metric.post_id, post.id)),
		list,
	)
	const [items, meta] = queryHelpers.paginate(rows, list)
	return [items.map((row) => row["id"] as string), meta.nextCursor]
}

type Walk = { deleting: boolean; direction: "asc" | "desc" }

/** Every id the list `kind` serves `direction`, one a page, at most five pages, deleting each page's rows when `deleting` */
async function served(db: Db, kind: (typeof KINDS)[number], { deleting, direction }: Walk) {
	const ids: string[] = []
	let cursor: string | undefined
	for (let n = 0; n < 5; n++) {
		const [page, next] = await pageOf(db, kind, { ...schema.parse({ order: `k.${direction}` }), cursor })
		ids.push(...page)
		if (deleting)
			for (const id of page) {
				await db.delete(post).where(eq(post.id, id))
				await db.delete(metric).where(eq(metric.post_id, id))
			}
		if (next === null) break
		cursor = next
	}
	return ids
}

describe("a Postgres timestamptz read as an Invalid Date pages, never repeating a row without end (AB3-9 of area B; sibling: AB3-4)", () => {
	const sessions = usePg()

	it.each(KINDS)("pages the %s list under DateStyle 'SQL, DMY' in Asia/Kolkata, every row once", async (kind) => {
		for (const deleting of [false, true])
			for (const direction of ["asc", "desc"] as const) {
				await sessions.pg().query(`DROP TABLE IF EXISTS ds_date_post, ds_date_metric; ${SEED}`)
				await sessions.sql().unsafe(`DROP TABLE IF EXISTS ds_date_post, ds_date_metric; ${SEED}`)
				const dbs = {
					"node-postgres": nodeDrizzle({ client: sessions.pg(), relations: RELATIONS }),
					"postgres.js": jsDrizzle({ client: sessions.sql(), relations: RELATIONS }),
				}
				for (const [driver, db] of Object.entries(dbs))
					expect(
						await served(db as unknown as Db, kind, { deleting, direction }),
						`${driver} ${direction}${deleting ? " deleting" : ""}`,
					).toEqual(SERVED[direction])
			}
	})
})
