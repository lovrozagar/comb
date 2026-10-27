/**
 * 3.24 on libsql: a seconds- or milliseconds-mode timestamp holding ±Infinity pages every row once,
 * in SQLite's order, through both builders, and a deleted infinite anchor repeats rows and skips
 * none. tests/bun runs the same on bun:sqlite; D1 reads ±Infinity as null (U24).
 */
import { drizzle } from "drizzle-orm/libsql"
import { describe, expect, it } from "vitest"
import { libsqlMemory } from "../support/libsql.ts"
import {
	MOMENT_ORDERS,
	MOMENT_SEED,
	type MomentEngine,
	momentRelations,
	momentsInOrder,
	momentsViaBuilder,
	momentsViaRelational,
	pageMoments,
} from "../support/infinite-dates.ts"

/** libsql in memory, seeded */
async function seeded() {
	const harness = libsqlMemory()
	for (const statement of MOMENT_SEED) await harness.client.execute(statement)
	const engine: MomentEngine = {
		exec: async (statement) => {
			await harness.client.execute(statement)
		},
		ids: async (query) => (await harness.client.execute(query)).rows.map((row) => Number(row[0])),
	}
	const db = drizzle({ client: harness.client, relations: momentRelations })
	const pages = {
		buildListQuery: momentsViaBuilder(harness.db as never),
		listOptions: momentsViaRelational(db as never),
	}
	return { close: harness.close, engine, pages }
}

describe("keyset pagination on a SQLite timestamp holding ±Infinity, on libsql (3.24)", () => {
	for (const via of ["buildListQuery", "listOptions"] as const) {
		for (const limit of [1, 2]) {
			it.each(MOMENT_ORDERS)(`pages %s through ${via}, ${limit} at a time, every row once`, async (order) => {
				const { close, engine, pages } = await seeded()
				try {
					expect((await pageMoments(engine, pages[via], { limit, order })).seen).toEqual(
						await momentsInOrder(engine, order),
					)
				} finally {
					close()
				}
			})
		}

		it.each(MOMENT_ORDERS)(`skips no row on %s through ${via} once an infinite anchor is deleted`, async (order) => {
			const { close, engine, pages } = await seeded()
			try {
				const all = await momentsInOrder(engine, order)
				const { deleted, seen } = await pageMoments(engine, pages[via], { deleteInfinite: true, limit: 1, order })
				expect(deleted).toBeDefined()
				expect(all.filter((id) => id !== deleted && !seen.includes(id))).toEqual([])
			} finally {
				close()
			}
		})
	}
})
