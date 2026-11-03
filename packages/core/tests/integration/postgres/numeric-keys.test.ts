/**
 * QL3 of r22b: a Postgres `numeric` read in drizzle's number mode reads 0.1000000000000000001, …2 and
 * …3 all as 0.1, a double that is no row's key. Every list path bound that double: ascending
 * re-served the first row forever, descending skipped the rest, on the anchorless and the anchored
 * derived list, the table list and the relational `listOptions`. Each now carries the numeric's
 * text, so a cursor resumes exactly, its row there or deleted. Ids are out of key order. 0.19.0
 * did the same.
 */
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { numeric, pgTable, text } from "drizzle-orm/pg-core"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { built as pagedAs } from "../../../src/query/__fixtures__/built.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { usePg } from "../support/pg.ts"

const item = pgTable("num_item", { id: text("id").primaryKey(), n: numeric("n", { mode: "number" }) })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["n"] })
const SERVED = { asc: ["d", "a", "c", "b"], desc: ["b", "c", "a", "d"] } as const
type Path = "anchored" | "anchorless" | "relational" | "table"
type Walk = { direction: "asc" | "desc"; gone: boolean; path: Path }

/** One page of `path` after `cursor`: its rows and what paginate reads them by */
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
	await client.query(`CREATE TEMP TABLE IF NOT EXISTS num_item (id text PRIMARY KEY, n numeric);
	DELETE FROM num_item;
	INSERT INTO num_item VALUES ('d', 0.1000000000000000001), ('a', 0.1000000000000000002), ('c', 0.1000000000000000003), ('b', 0.2)`)
	const ids: string[] = []
	let cursor: string | undefined
	for (let n = 1; n <= 8; n++) {
		const query = { ...schema.parse({ order: `n.${direction}` }), cursor }
		const [rows, built] = await pageOf(client, path, query)
		const [items, meta] = queryHelpers.paginate(rows, built)
		const page = items.map((row) => row["id"] as string)
		ids.push(...page)
		if (meta.nextCursor === null) return ids
		if (gone) await client.query("DELETE FROM num_item WHERE id = $1", [page.at(-1)])
		cursor = meta.nextCursor
	}
	return ids
}

describe("a fixed number that isn't a safe integer is carried exactly (QL3; sibling: r22 Q1's integral rule)", () => {
	const sessions = usePg()

	it.each(["anchorless", "anchored", "table", "relational"] as const)(
		"pages a numeric in number mode finer than a double on the %s path every row once, asc and desc, its cursor's row there or deleted",
		async (path) => {
			for (const direction of ["asc", "desc"] as const)
				for (const gone of [false, true])
					expect(await served(sessions.pg(), { direction, gone, path }), `${direction} gone ${gone}`).toEqual(
						SERVED[direction],
					)
		},
	)
})
