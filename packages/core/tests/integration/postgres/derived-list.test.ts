/**
 * A derived list on a real Postgres (Q1 of r21): a union inbox whose id and key are SQL expressions,
 * paged with `dialect: "postgres"`, and lists whose Postgres column sits inside an expression, paged
 * with no option. 0.19.0 sent SQLite's typeof() to each and every page failed with `function
 * typeof(bigint) does not exist`; v0.18.0 paged them.
 */
import { type SQL, type SQLWrapper, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { bigint, pgTable, text } from "drizzle-orm/pg-core"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { buildDerivedListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { usePg } from "../support/pg.ts"

const orgItem = pgTable("org_i", { created_at: bigint("created_at", { mode: "number" }), id: text("id").primaryKey() })
const inbox = sql`(SELECT 'org:' || id AS uid, created_at FROM org_i UNION ALL SELECT 'prj:' || id, created_at FROM prj_i) AS inbox`
const ROWS = { asc: ["org:a", "org:c", "org:b", "prj:a", "prj:d"], desc: ["prj:d", "prj:a", "org:b", "org:c", "org:a"] }

type Shape = {
	dialect?: "postgres"
	from: SQL
	idColumn: SQLWrapper
	key: SQLWrapper | { sql: SQLWrapper; type: "date" }
}

/** Every row of `shape`, `direction`, by cursor or by page, two a page, read on `client` */
const pager =
	(client: pg.Client) =>
	async (shape: Shape, direction: "asc" | "desc", by: "cursor" | "page"): Promise<string[]> => {
		/* the session's tables, made by its first page run */
		await client.query(`CREATE TEMP TABLE IF NOT EXISTS org_i (id text PRIMARY KEY, created_at bigint);
		CREATE TEMP TABLE IF NOT EXISTS prj_i (id text PRIMARY KEY, created_at bigint);
		INSERT INTO org_i VALUES ('a', 3), ('b', 12), ('c', 7) ON CONFLICT DO NOTHING;
		INSERT INTO prj_i VALUES ('a', 25), ('d', 100) ON CONFLICT DO NOTHING`)
		const db = drizzle({ client })
		const ids: string[] = []
		let cursor: string | undefined
		for (let n = 1; n <= 8; n++) {
			const built = buildDerivedListQuery({
				...SEALED,
				...(shape.dialect === undefined ? {} : { dialect: shape.dialect }),
				idColumn: shape.idColumn,
				parsed: {
					...(by === "cursor" ? { cursor } : { page: n }),
					limit: 2,
					parsedSort: [{ direction, field: "created_at" }],
				},
				sortColumns: { created_at: shape.key },
			})
			const extras = Object.values(built.extras as Record<string, { fieldAlias: string; sql: SQL }>).map(
				(extra) => sql`, ${extra.sql} AS ${sql.identifier(extra.fieldAlias)}`,
			)
			const where = built.where === undefined ? sql`` : sql` WHERE ${built.where}`
			const rows = await db.execute(
				sql`SELECT ${shape.idColumn} AS id, ${typeof shape.key === "object" && "type" in shape.key ? shape.key.sql : shape.key} AS created_at${sql.join(extras, sql``)} FROM ${shape.from}${where} ORDER BY ${sql.join(built.orderBy, sql`, `)} LIMIT ${built.limit} OFFSET ${built.offset}`,
			)
			const [items, meta] = queryHelpers.paginate(rows.rows as Array<{ id: string }>, built)
			ids.push(...items.map((row) => row.id))
			if (!meta.hasMore) break
			cursor = meta.nextCursor ?? undefined
		}
		return ids
	}

describe("a Postgres derived list pages every row once (Q1 of r21)", () => {
	const sessions = usePg()
	const page = (...args: Parameters<ReturnType<typeof pager>>) => pager(sessions.pg())(...args)

	it.each(["asc", "desc"] as const)('pages the union inbox, %s, with `dialect: "postgres"`', async (direction) => {
		const shape = { dialect: "postgres" as const, from: inbox, idColumn: sql`inbox.uid`, key: sql`inbox.created_at` }
		expect(await page(shape, direction, "cursor")).toEqual(ROWS[direction])
		expect(await page(shape, direction, "page")).toEqual(ROWS[direction])
	})

	/* the rows of org_i alone, by an id and a key whose Postgres column sits inside an expression */
	const ORG = { asc: ["org:a", "org:c", "org:b"], desc: ["org:b", "org:c", "org:a"] }
	const id = sql`'org:' || ${orgItem.id}`
	it.each([
		["an sql`` template", { from: sql`org_i`, idColumn: id, key: sql`coalesce(${orgItem.created_at}, 0)` }],
		[
			"{ sql, type: date }",
			{ from: sql`org_i`, idColumn: id, key: { sql: sql`${orgItem.created_at} * 1000`, type: "date" as const } },
		],
	])("pages a list whose column sits inside %s, with no option", async (_, shape) => {
		for (const direction of ["asc", "desc"] as const) {
			expect(await page(shape, direction, "cursor")).toEqual(ORG[direction])
			expect(await page(shape, direction, "page")).toEqual(ORG[direction])
		}
	})
})
