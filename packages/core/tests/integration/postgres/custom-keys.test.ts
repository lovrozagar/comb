/**
 * AB2 of area B on Postgres: a list sorted by a drizzle `customType` column minted a cursor the next
 * request answered `invalid_cursor`, a 400, as the fit check knew no `custom` family. The column here
 * is a domain over numeric its mapper reads as a JS number, and the four values agree past a double's
 * digits, so every one reads as 0.1: the list carries the key's text, as it does an expression over
 * numeric, and each path pages every row once, with the cursor's row kept or deleted before the next
 * page. Ids are out of key order.
 *
 * comb-9d's round-two finding on AB2: a customType over text whose toDriver rewrites a numeric-looking
 * value (`12` stored as `sku-12`) carries no text, so its cursor holds the value as read, and AB2
 * bound a numeric-looking one past toDriver: ascending repeated one row forever, descending stopped
 * after one. Each path pages it every row once too. comb-9d's ruling on the fix binds a carried text
 * as an untyped parameter, which Postgres types as the key it is compared with; postgres.js infers a
 * parameter's type itself, so both keys page on node-postgres and on postgres.js alike.
 */
import { drizzle } from "drizzle-orm/node-postgres"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import { customType, numeric, type PgAsyncDatabase, type PgQueryResultHKT, pgTable, text } from "drizzle-orm/pg-core"
import type pg from "pg"
import type postgres from "postgres"
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

/* a SKU the app reads bare and the column stores prefixed, where it looks like a number */
const sku = customType<{ data: string; driverData: string }>({
	dataType: () => "text",
	fromDriver: (value) => value.replace(/^sku-/, ""),
	toDriver: (value) => (/^\d+(?:\.\d+)?$/.test(value) ? `sku-${value}` : value),
})

const item = pgTable("custom_item", {
	a: amount("a"),
	id: text("id").primaryKey(),
	n: numeric("n", { mode: "number" }),
	s: sku("s"),
})
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["a", "n", "s"] })
/* by `a` and `n`, and by `s`'s stored text: sku-12 < sku-3 < sku-45 < sku-7 */
const SERVED = {
	a: { asc: ["d", "a", "c", "b"], desc: ["b", "c", "a", "d"] },
	n: { asc: ["d", "a", "c", "b"], desc: ["b", "c", "a", "d"] },
	s: { asc: ["a", "c", "b", "d"], desc: ["d", "b", "c", "a"] },
} as const
type Key = keyof typeof SERVED
type Path = "anchored" | "anchorless" | "table"
/** One session, on node-postgres or on postgres.js, its statements run as given */
type Session = { db: PgAsyncDatabase<PgQueryResultHKT>; run(statement: string, params?: unknown[]): Promise<unknown[]> }

/** `client` as a Session */
const onPg = (client: pg.Client): Session => ({
	db: drizzle({ client }),
	run: async (statement, params) => (await client.query(statement, params)).rows,
})

/** `sql` as a Session, its one connection holding the TEMP tables */
const onPostgresJs = (sql: postgres.Sql): Session => ({
	db: drizzlePostgres({ client: sql }),
	run: async (statement, params) => [...(await sql.unsafe(statement, params as never[]))],
})

/** The session's domain and table, holding the four rows afresh */
async function seed(session: Session): Promise<void> {
	const [made] = (await session.run("SELECT to_regclass('pg_temp.custom_item') AS t")) as { t: unknown }[]
	if (made?.t === null) {
		await session.run("CREATE DOMAIN pg_temp.amount AS numeric")
		await session.run("CREATE TEMP TABLE custom_item (id text PRIMARY KEY, a pg_temp.amount, n numeric, s text)")
	}
	await session.run("DELETE FROM custom_item")
	await session.run(`
	INSERT INTO custom_item VALUES ('d', 0.1000000000000000001, 0.5, 'sku-7'), ('a', 0.1000000000000000002, 1.5, 'sku-12'),
		('c', 0.1000000000000000003, 2.5, 'sku-3'), ('b', 0.1000000000000000004, 3.5, 'sku-45')`)
}

/** The list `path` builds for `query` */
function listOf(path: Path, query: ReturnType<typeof schema.parse>) {
	if (path === "table") return buildListQuery({ ...SEALED, parsed: query, table: item as never })
	const anchor = path === "anchored" ? { anchor: { idColumn: item.id, table: item } } : { idColumn: item.id }
	return buildDerivedListQuery({
		...SEALED,
		...anchor,
		parsed: query,
		sortColumns: { a: item.a, n: item.n, s: item.s },
	})
}

/** Every id `path` serves by `key`, one a page, by cursor from `from` (its row `gone` deleted first), deleting each page's rows when `deleting` */
async function served(
	session: Session,
	path: Path,
	{
		deleting,
		direction,
		from,
		gone,
		key,
	}: { deleting: boolean; direction: "asc" | "desc"; from?: string | undefined; gone?: string | undefined; key: Key },
) {
	await seed(session)
	if (gone !== undefined) await session.run("DELETE FROM custom_item WHERE id = $1", [gone])
	const ids: string[] = []
	let cursor: string | undefined = from
	for (let n = 1; n <= 8; n++) {
		const query = { ...schema.parse({ order: `${key}.${direction}` }), cursor }
		const built = listOf(path, query)
		const select = session.db
			.select({ a: item.a, id: item.id, n: item.n, s: item.s, ...built.extras })
			.from(item)
			.$dynamic()
		const rows = await (built.where === undefined ? select : select.where(built.where))
			.orderBy(...built.orderBy)
			.limit(built.limit)
		const [items, meta] = queryHelpers.paginate(rows, built)
		const page = items.map((row) => row["id"] as string)
		ids.push(...page)
		if (deleting) for (const id of page) await session.run("DELETE FROM custom_item WHERE id = $1", [id])
		if (meta.nextCursor === null) return ids
		cursor = meta.nextCursor
	}
	return ids
}

describe("a customType key pages or is refused at the mint, on Postgres (AB2 of area B; sibling: QL5's bytea)", () => {
	const sessions = usePg()

	const DRIVERS = { "node-postgres": () => onPg(sessions.pg()), "postgres.js": () => onPostgresJs(sessions.sql()) }
	const CASES = (["table", "anchored", "anchorless"] as const).flatMap((path) =>
		(["node-postgres", "postgres.js"] as const).map((driver) => [path, driver] as const),
	)

	it.each(CASES)(
		"pages a customType key over a numeric domain on the %s list every row once on %s, its cursor row there or deleted",
		async (path, driver) => {
			for (const deleting of [false, true])
				for (const direction of ["asc", "desc"] as const)
					expect(
						await served(DRIVERS[driver](), path, { deleting, direction, key: "a" }),
						`${direction} ${deleting}`,
					).toEqual(SERVED.a[direction])
		},
	)

	/* comb-9d's round-two finding on AB2: a numeric-looking value was bound past toDriver */
	it.each(CASES)(
		"pages a customType key over text whose toDriver rewrites a numeric-looking value on the %s list every row once on %s",
		async (path, driver) => {
			for (const deleting of [false, true])
				for (const direction of ["asc", "desc"] as const)
					expect(
						await served(DRIVERS[driver](), path, { deleting, direction, key: "s" }),
						`${direction} ${deleting}`,
					).toEqual(SERVED.s[direction])
		},
	)
})

/*
 * comb-9d's AB2 ruling: a cursor without the carried flag holds every value as read, as every cursor a
 * released comb minted does; refused, every client mid-list would be a 400 at the upgrade. These are
 * the page-1 cursors comb 0.20.1, from its npm tarball, minted for the table list here, sealed under
 * SEALED (.tmp/grunt/p21/oracle/ab2r-mint.ts).
 */
const MINTED_0_20_1: Record<`${"n" | "s"}.${"asc" | "desc"}`, string> = {
	"n.asc":
		"AYVHRs2U6VvQuoIniJaZk6UweU0MoWStrkxAGL_fZe0htrUucZ3m789LRsh2sJr62pWElcbyJ6dKTMxyMHlTzlBr-LS9HnzGbBqE10cigYFaqH1kYOFKRd6OlNE_re-uucvFzNQAS5qrEJ1ZtIfCe4Z4oMTmVVzonIgoCY9-HzNp-NJy89PKD55ZsLOzL5aq9u-T5Na7QPy79FecHVAeo_pk-bC6ne5zZDeXJSvnCYzEdeWueNRVuvBwYbv5hsanh2UBeSDroBcxs7Hj8CVkp2-PPKbilNIFbaf4C2226Xa22JyO7nOdsGtXoos_JocKT5ull2kPVtEBSL30br3PD-S93Sw24YyBNAe3IMfGCwgJoEzXZPqO2q4R1ZFz3wosMqhLlzx-mrQs",
	"n.desc":
		"AZvaSZnr-z-YHpLmwWJm2mBxPTdoASHQ53dVFdhYS9JYh9C722uZKFlbq4BudfeGO3wB78a1j3o_FTG_7P0YNH0ncRmlYD0mwUmo-vJGz9HfTaR5YjVttNoVxkmap0c2EBCJkupJNUZqFZa4_-fUnGfbJpc6tu5j1dnHTZIWqYn0FFA_rHhpDuFpEY5v0ZVt_hCm4B3QZNv_p5VBF8AwQMsqylrP4XqKszdtKjiEJJ7TNVTd-ZeBJ006uRJgIuTlfaXB91LmOVElKcY6ETNGwgm20bFtS02MbWuervXqoFByuGTDDyXTZcD6Q6m0imYpmwCQGlq518klPXmJ47SlDsHZ3H_ssjlCpmBbLG9vhxkRklHW_Ev-tfdrZTpAfQzOsKcHYxn93dzp",
	"s.asc":
		"Ab25mXfJRRrwYwTd7v2-vq20fenRoLGpj0lf7gE5p9-ss_q7m3Ps5FlxboNIp-jXEzBQw8fyNsqBQatcRYq8D2miieKke7UniHKnDF4gBIDRxxwsiXrRTB_zxd9iBDto5gAW-uAF1iILBFgY5rDKjg6WvhlUuBkWaBK-YuQaIfZWHx1rJQJIPQQ4OvYkVvCwztPP_a3WqqY-kcWVu_oJbRTRPfm6fitBBKDZcFk1LmOdrwH1kiYa30xyr5JiQ2be0rhMcs4G0oc8uYASMcHS8-IiBtveWvYmtznAMDRLmEbexKDpyXHLt0jg0BB-GtPo9pHb8M1JbO47vR9xV41yEWQl12Ss6V2jue6d8ODXy-OVaYhr277KqPWb25QuluH_U8ntRRPzUIdD",
	"s.desc":
		"AWQAFAAMyLWHAVVBIAksaPuZxuXVlsuUJ3V4-8JWDBCsQlu00uHcOCaa3TCGKllxWWvjM38bxbtJ-BZAjeExW5tRerCBBQj_4kLf73oRyRMKKtCLxRswNifxoEKzp2gRzs2w8bVGeQs15NvTkhrzhGPcwWdaWFql8a5WGMbN876qPXiovX7_RwVq2PoKHurDWFiJaTBLhmMBBjNb2EiIPPlE2XO3et8x8tLIACD6LWIMMr5jeeCDg8x9NFZbjEAmYsBmL3e-Lzp-urFa_IBVe2wDJev6gobckw17W5d-QpJlctQptqH_hV2UNPERhKgdknMMB7yuNX7v6PDMqElxeQu0Hh30HUPqaEUS-VMCRnV2hiARZTU6qeVdnrXT_iD4vboIwudhxcH4",
}

describe("a cursor comb 0.20.1 minted pages on after the upgrade (comb-9d's AB2 ruling; sibling: the flagged cursor above)", () => {
	const sessions = usePg()

	it.each(["n", "s"] as const)(
		"pages the rest of the %s list from 0.20.1's page-1 cursor, its row there or deleted",
		async (key) => {
			for (const deleting of [false, true])
				for (const direction of ["asc", "desc"] as const) {
					const from = MINTED_0_20_1[`${key}.${direction}`]
					const gone = deleting ? SERVED[key][direction][0] : undefined
					expect(
						await served(onPg(sessions.pg()), "table", { deleting, direction, from, gone, key }),
						`${direction} ${deleting}`,
					).toEqual(SERVED[key][direction].slice(1))
				}
		},
	)
})
