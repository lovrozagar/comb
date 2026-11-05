/**
 * AB3-3 of area B on Postgres: readCursor returned the value a list binds for a key it re-types, not
 * the value the row read: a numeric read in drizzle's number mode as 0.1 came back as the text
 * "0.1000000000000000001" it pages by, and an expression over a timestamp the driver read as
 * "2024-01-01 00:00:00.000001" as to_json's "2024-01-01T00:00:00.000001". Two rows hold one key
 * value, a page holds one, and each list kind's next cursor is set against the key the served row
 * read, on node-postgres and postgres.js.
 */
import { eq, getTableColumns, sql } from "drizzle-orm"
import { drizzle as nodeDrizzle } from "drizzle-orm/node-postgres"
import { numeric, type PgAsyncDatabase, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { drizzle as jsDrizzle } from "drizzle-orm/postgres-js"
import { describe, expect, it } from "vitest"
import { readCursor } from "../../../src/query/cursor.ts"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { type PgSessions, usePg } from "../support/pg.ts"

const KEYS = {
	"numeric in number mode": {
		column: () => numeric("k", { mode: "number" }),
		ddl: "numeric",
		literal: "0.1000000000000000001",
	},
	"timestamp(6) in string mode": {
		column: () => timestamp("k", { mode: "string", precision: 6 }),
		ddl: "timestamp(6)",
		literal: "'2024-01-01 00:00:00.000001'",
	},
} as const
const KINDS = ["table", "anchored own", "anchored joined", "anchorless", "expression"] as const

const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["k"] })
const parsed = schema.parse({ order: "k.asc" })

/** The key the first page's row read on the list `kind`, on `db`, and the key readCursor opens from its next cursor */
async function readBack(
	db: PgAsyncDatabase<any, any>,
	key: (typeof KEYS)[keyof typeof KEYS],
	kind: (typeof KINDS)[number],
): Promise<{ back: unknown; read: unknown }> {
	const post = pgTable("rc_post", { id: text("id").primaryKey(), k: key.column() })
	const metric = pgTable("rc_metric", { k: key.column(), post_id: text("post_id") })
	const sortKey = kind === "anchored joined" ? metric.k : kind === "expression" ? sql`${post.k}` : post.k
	const sortColumns = { k: sortKey }
	const list =
		kind === "table"
			? buildListQuery({ ...SEALED, parsed, table: post })
			: kind === "anchorless" || kind === "expression"
				? buildDerivedListQuery({ ...SEALED, idColumn: post.id, parsed, sortColumns })
				: buildDerivedListQuery({ ...SEALED, anchor: { idColumn: post.id, table: post }, parsed, sortColumns })
	const rows = await applyListQuery(
		(extras) =>
			db
				.select({ ...getTableColumns(post), k: sortKey, ...extras })
				.from(post)
				.innerJoin(metric, eq(metric.post_id, post.id)),
		list,
	)
	const [items, meta] = queryHelpers.paginate(rows, list)
	return { back: readCursor(meta.nextCursor as string, parsed.parsedSort, SEALED).values[0], read: items[0]?.["k"] }
}

/** The session's TEMP tables, both rows holding `key`'s literal */
const seed = (key: (typeof KEYS)[keyof typeof KEYS]) => `
	CREATE TEMP TABLE rc_post (id text PRIMARY KEY, k ${key.ddl});
	CREATE TEMP TABLE rc_metric (post_id text, k ${key.ddl});
	INSERT INTO rc_post VALUES ('a', ${key.literal}), ('b', ${key.literal});
	INSERT INTO rc_metric SELECT id, k FROM rc_post`

/** Each driver's drizzle over the session's TEMP tables, seeded for `key` */
async function dbsOf(sessions: PgSessions, key: (typeof KEYS)[keyof typeof KEYS]) {
	await sessions.pg().query(seed(key))
	await sessions.sql().unsafe(seed(key))
	return {
		"node-postgres": nodeDrizzle({ client: sessions.pg() }),
		"postgres.js": jsDrizzle({ client: sessions.sql() }),
	}
}

describe("readCursor returns each key as the row read it, on Postgres (AB3-3 of area B)", () => {
	const sessions = usePg()

	it.each(Object.keys(KEYS) as Array<keyof typeof KEYS>)(
		"returns a %s key as its row read it on every list",
		async (name) => {
			const key = KEYS[name]
			for (const [driver, db] of Object.entries(await dbsOf(sessions, key)))
				for (const kind of KINDS) {
					const { back, read } = await readBack(db as PgAsyncDatabase<any, any>, key, kind)
					expect(back, `${driver} ${kind}`).toEqual(read)
				}
		},
	)
})
