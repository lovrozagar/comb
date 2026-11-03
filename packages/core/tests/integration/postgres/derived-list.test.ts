/**
 * A derived list on a real Postgres (Q1 of r21): a union inbox whose id and key are SQL expressions,
 * paged with `dialect: "postgres"`, and lists whose Postgres column sits inside an expression, paged
 * with no option. 0.19.0 sent SQLite's typeof() to each and every page failed with `function
 * typeof(bigint) does not exist`; v0.18.0 paged them.
 */
import { type SQL, type SQLWrapper, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { bigint, doublePrecision, numeric, type PgColumn, pgTable, text } from "drizzle-orm/pg-core"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { buildDerivedListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { usePg } from "../support/pg.ts"

const score = pgTable("score", {
	b: bigint("b", { mode: "number" }).notNull(),
	f: doublePrecision("f").notNull(),
	id: text("id").primaryKey(),
})
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

/*
 * Q2 of r21, the sibling r20 Q1's SQLite fix missed: a double precision key past 2^53 is exact as
 * node-postgres reads it, so a derived list with no anchor pages it; a bigint read as a number is
 * rounded, and stays refused. 0.19.0 refused both as rounded.
 */
describe("a Postgres derived list judges a key past 2^53 by its type (Q2 of r21)", () => {
	const sessions = usePg()

	/** Every id of `score` by `key`, one a page, by cursor; a column read through its own mode */
	async function scores(key: SQL | PgColumn, direction: "asc" | "desc"): Promise<string[]> {
		const client = sessions.pg()
		await client.query(`CREATE TEMP TABLE IF NOT EXISTS score (id text PRIMARY KEY, f double precision NOT NULL, b bigint NOT NULL);
		INSERT INTO score VALUES ('a', 1e20, 1152921504606846977), ('b', 2e20, 1152921504606846979),
		('c', 3e20, 1152921504606846981), ('d', 4e20, 1152921504606846983) ON CONFLICT DO NOTHING`)
		const db = drizzle({ client })
		const ids: string[] = []
		let cursor: string | undefined
		for (let n = 1; n <= 8; n++) {
			const built = buildDerivedListQuery({
				...SEALED,
				idColumn: score.id,
				parsed: { cursor, limit: 1, parsedSort: [{ direction, field: "k" }] },
				sortColumns: { k: key },
			})
			const query = db
				.select({ id: score.id, k: key, ...built.extras })
				.from(score)
				.$dynamic()
			const rows = await (built.where === undefined ? query : query.where(built.where))
				.orderBy(...built.orderBy)
				.limit(built.limit)
			const [items, meta] = queryHelpers.paginate(rows, built)
			ids.push(...items.map((row) => row.id))
			if (meta.nextCursor === null) break
			cursor = meta.nextCursor
		}
		return ids
	}

	it.each([
		["a double precision column", score.f],
		["a double precision expression", sql`${score.f} * 1`],
	])("pages every row once by %s holding 1e20 to 4e20, asc and desc", async (_, key) => {
		expect(await scores(key, "asc")).toEqual(["a", "b", "c", "d"])
		expect(await scores(key, "desc")).toEqual(["d", "c", "b", "a"])
	})

	it("refuses a bigint read as a number past 2^53, which the driver rounded", async () => {
		for (const direction of ["asc", "desc"] as const)
			await expect(scores(score.b, direction)).rejects.toMatchObject({
				cause: expect.stringMatching(/^k \d+ is past ±\(2\^53 − 1\), where the driver rounded it: a derived list/),
				errorKey: "sort_not_wired",
			})
	})
})

const ledger = pgTable("ledger", {
	cents: bigint("cents", { mode: "number" }).notNull(),
	exact: numeric("exact", { mode: "number" }).notNull(),
	id: text("id").primaryKey(),
	ratio: doublePrecision("ratio").notNull(),
})

/*
 * Q1 of r22, the sibling r21 Q2's open family list missed: a domain is no family pg_typeof names, so a
 * domain over bigint read as a number past 2^53 paged as exact, serving one row or one row eight
 * times. The key's class follows the domain to its base type, and a class not known to be a double
 * is refused past 2^53. 0.19.0 refused every key past 2^53 here.
 */
describe("a key whose class isn't a double is exact or refused (Q1; sibling: r21 Q2's open family list)", () => {
	const sessions = usePg()

	/** Every id of `ledger` by `key`, one a page, by cursor */
	async function ledgerIds(key: PgColumn, direction: "asc" | "desc"): Promise<string[]> {
		const client = sessions.pg()
		const [made] = (await client.query("SELECT to_regclass('pg_temp.ledger') AS t")).rows
		if (made?.t === null)
			await client.query(`CREATE DOMAIN pg_temp.cents AS bigint;
		CREATE DOMAIN pg_temp.cents2 AS pg_temp.cents;
		CREATE DOMAIN pg_temp.exact AS numeric;
		CREATE DOMAIN pg_temp.ratio AS double precision;
		CREATE TEMP TABLE ledger (id text PRIMARY KEY, cents pg_temp.cents2 NOT NULL, exact pg_temp.exact NOT NULL, ratio pg_temp.ratio NOT NULL);
		INSERT INTO ledger VALUES ('a', 1152921504606846977, 1152921504606846977, 1e20), ('b', 1152921504606846979, 1152921504606846979, 2e20),
		('c', 1152921504606846981, 1152921504606846981, 3e20), ('d', 1152921504606846983, 1152921504606846983, 4e20)`)
		const db = drizzle({ client })
		const ids: string[] = []
		let cursor: string | undefined
		for (let n = 1; n <= 8; n++) {
			const built = buildDerivedListQuery({
				...SEALED,
				idColumn: ledger.id,
				parsed: { cursor, limit: 1, parsedSort: [{ direction, field: "k" }] },
				sortColumns: { k: key },
			})
			const query = db
				.select({ id: ledger.id, k: key, ...built.extras })
				.from(ledger)
				.$dynamic()
			const rows = await (built.where === undefined ? query : query.where(built.where))
				.orderBy(...built.orderBy)
				.limit(built.limit)
			const [items, meta] = queryHelpers.paginate(rows, built)
			ids.push(...items.map((row) => row.id))
			if (meta.nextCursor === null) break
			cursor = meta.nextCursor
		}
		return ids
	}

	it.each([
		["a domain over a domain over bigint", ledger.cents],
		["a domain over numeric in number mode", ledger.exact],
	])("refuses %s holding 2^60 + 1 to 2^60 + 7, asc and desc", async (_, key) => {
		for (const direction of ["asc", "desc"] as const)
			await expect(ledgerIds(key, direction)).rejects.toMatchObject({
				cause: expect.stringMatching(/^k \d+ is past ±\(2\^53 − 1\), where the driver rounded it: a derived list/),
				errorKey: "sort_not_wired",
			})
	})

	it("pages every row once by a domain over double precision holding 1e20 to 4e20, asc and desc", async () => {
		expect(await ledgerIds(ledger.ratio, "asc")).toEqual(["a", "b", "c", "d"])
		expect(await ledgerIds(ledger.ratio, "desc")).toEqual(["d", "c", "b", "a"])
	})
})
