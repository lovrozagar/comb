/**
 * QL4 of r22b: the derived and table builders bound a cursor's values by SQLite's rules whatever the
 * list's dialect, so a Postgres `double precision` key at ±Infinity resumed as the literal `9e999`,
 * which Postgres reads as a numeric past every double: the page after that row was a 500. The
 * relational `listOptions` bound by the column's dialect and paged right. Each builder now resolves
 * the dialect once and binds by it. Ids are out of key order.
 */
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { doublePrecision, pgTable, text } from "drizzle-orm/pg-core"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { built as pagedAs } from "../../../src/query/__fixtures__/built.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { usePg } from "../support/pg.ts"

const item = pgTable("dbl_item", { id: text("id").primaryKey(), n: doublePrecision("n") })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["n"] })
const SERVED = { asc: ["d", "a", "c", "b"], desc: ["b", "c", "a", "d"] } as const
type Path = "anchored" | "anchorless" | "relational" | "table"
type Walk = { direction: "asc" | "desc"; gone: boolean; path: Path }

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
			: path === "anchored"
				? buildDerivedListQuery({
						...SEALED,
						anchor: { idColumn: item.id, table: item },
						parsed: query,
						sortColumns: { n: item.n },
					})
				: buildDerivedListQuery({ ...SEALED, idColumn: item.id, parsed: query, sortColumns: { n: item.n } })
	const select = drizzle({ client })
		.select({ id: item.id, n: item.n, ...built.extras })
		.from(item)
		.$dynamic()
	const rows = await (built.where === undefined ? select : select.where(built.where))
		.orderBy(...built.orderBy)
		.limit(built.limit)
	return [rows, built]
}

/** Every id `path` serves by `n`, one a page, by cursor, at most eight pages; `gone` deletes each cursor's row */
async function served(client: pg.Client, { direction, gone, path }: Walk): Promise<string[]> {
	await client.query(`CREATE TEMP TABLE IF NOT EXISTS dbl_item (id text PRIMARY KEY, n double precision);
	DELETE FROM dbl_item;
	INSERT INTO dbl_item VALUES ('d', '-Infinity'), ('a', 0.5), ('c', 1.5), ('b', 'Infinity')`)
	const ids: string[] = []
	let cursor: string | undefined
	for (let n = 1; n <= 8; n++) {
		const query = { ...schema.parse({ order: `n.${direction}` }), cursor }
		const [rows, built] = await pageOf(client, path, query)
		const [items, meta] = queryHelpers.paginate(rows, built)
		const page = items.map((row) => row["id"] as string)
		ids.push(...page)
		if (meta.nextCursor === null) return ids
		if (gone) await client.query("DELETE FROM dbl_item WHERE id = $1", [page.at(-1)])
		cursor = meta.nextCursor
	}
	return ids
}

describe("the cursor binds by the list's dialect (QL4; sibling: r21 Q1)", () => {
	const sessions = usePg()

	it.each(["anchorless", "anchored", "table", "relational"] as const)(
		"pages a double precision key at ±Infinity on the %s path every row once, asc and desc, its cursor's row there or deleted",
		async (path) => {
			for (const direction of ["asc", "desc"] as const)
				for (const gone of [false, true])
					expect(await served(sessions.pg(), { direction, gone, path }), `${direction} gone ${gone}`).toEqual(
						SERVED[direction],
					)
		},
	)
})

/** Every id `path` serves by `n` descending, one a page, by cursor, at most six pages */
async function walked(client: pg.Client, path: Path): Promise<string[]> {
	const ids: string[] = []
	let cursor: string | undefined
	for (let n = 1; n <= 6; n++) {
		const query = { ...schema.parse({ order: "n.desc" }), cursor }
		const [rows, built] = await pageOf(client, path, query)
		const [items, meta] = queryHelpers.paginate(rows, built)
		ids.push(...items.map((row) => row["id"] as string))
		if (meta.nextCursor === null) break
		cursor = meta.nextCursor
	}
	return ids
}

/*
 * AB4-4 of area B: under extra_float_digits 0 or below Postgres prints a double rounded to 15
 * significant digits, so 1.0000000000000002 reads as 1, and its cursor skipped the rows that hold 1.
 * No text Postgres prints holds the double then, so the page that reads such a key is a 500 naming the
 * setting instead of a silent skip
 */
describe("a float key under extra_float_digits 0 is refused, never skipping rows (AB4-4 of area B; sibling: AB3-4)", () => {
	const sessions = usePg()

	it.each(["anchorless", "anchored", "table", "relational"] as const)(
		"answers a 500 naming extra_float_digits on the %s path's page that reads 1.0000000000000002",
		async (path) => {
			const client = sessions.pg()
			await client.query(`CREATE TEMP TABLE IF NOT EXISTS dbl_item (id text PRIMARY KEY, n double precision);
			DELETE FROM dbl_item;
			INSERT INTO dbl_item VALUES ('a', 1.0000000000000002), ('b', 1), ('c', 1), ('d', 1)`)
			await client.query("SET extra_float_digits = 0")
			try {
				await expect(walked(client, path)).rejects.toThrow(
					expect.objectContaining({ cause: expect.stringContaining("extra_float_digits"), errorKey: "sort_not_wired" }),
				)
			} finally {
				await client.query("RESET extra_float_digits")
			}
			expect(await walked(client, path)).toEqual(["a", "b", "c", "d"])
		},
	)
})
