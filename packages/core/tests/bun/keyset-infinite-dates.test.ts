/// <reference types="bun-types" />
/**
 * 3.24 on bun:sqlite: a seconds- or milliseconds-mode timestamp holding ±Infinity pages every row
 * once, in SQLite's order, through both builders, and a deleted infinite anchor repeats rows and
 * skips none. tests/integration/libsql runs the same on libsql.
 */
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import {
	MOMENT_ORDERS,
	MOMENT_SEED,
	type MomentEngine,
	momentRelations,
	momentsInOrder,
	momentsViaBuilder,
	momentsViaRelational,
	pageMoments,
} from "../integration/support/infinite-dates.ts"

/** bun:sqlite in memory, seeded */
function seeded() {
	const client = new Database(":memory:")
	for (const statement of MOMENT_SEED) client.run(statement)
	const engine: MomentEngine = {
		exec: async (statement) => {
			client.run(statement)
		},
		ids: async (query) =>
			client
				.query<{ id: number }, []>(query)
				.all()
				.map((row) => row.id),
	}
	const pages = {
		buildListQuery: momentsViaBuilder(drizzle({ client }) as never),
		listOptions: momentsViaRelational(drizzle({ client, relations: momentRelations }) as never),
	}
	return { client, engine, pages }
}

describe("keyset pagination on a SQLite timestamp holding ±Infinity, on bun:sqlite (3.24)", () => {
	for (const via of ["buildListQuery", "listOptions"] as const) {
		for (const limit of [1, 2]) {
			it.each(MOMENT_ORDERS)(`pages %s through ${via}, ${limit} at a time, every row once`, async (order) => {
				const { client, engine, pages } = seeded()
				try {
					expect((await pageMoments(engine, pages[via], { limit, order })).seen).toEqual(
						await momentsInOrder(engine, order),
					)
				} finally {
					client.close()
				}
			})
		}

		it.each(MOMENT_ORDERS)(`skips no row on %s through ${via} once an infinite anchor is deleted`, async (order) => {
			const { client, engine, pages } = seeded()
			try {
				const all = await momentsInOrder(engine, order)
				const { deleted, seen } = await pageMoments(engine, pages[via], { deleteInfinite: true, limit: 1, order })
				expect(deleted).toBeDefined()
				expect(all.filter((id) => id !== deleted && !seen.includes(id))).toEqual([])
			} finally {
				client.close()
			}
		})
	}
})
