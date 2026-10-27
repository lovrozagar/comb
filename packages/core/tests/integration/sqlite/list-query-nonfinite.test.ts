/**
 * A SQLite REAL holds ±Infinity (R4), which JSON writes as null and libsql refuses to bind. Each
 * order is paged one row at a time, through the SQL builder and the relational helper, and every
 * row comes back once, in the order SQLite gives; a NULL-keyed anchor deleted or set to 5 between
 * pages resumes from where its NULL stood (U4). tests/integration/d1 and tests/bun run the same on
 * D1 and bun:sqlite.
 */
import { drizzle } from "drizzle-orm/libsql"
import { describe, expect, it } from "vitest"
import type { CursorOptions } from "../../../src/query/cursor-seal.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { libsqlMemory } from "../support/libsql.ts"
import {
	type Edit,
	type Engine,
	ORDERS,
	pageAll,
	pointRelations,
	SEED,
	viaBuilder,
	viaRelational,
} from "../support/nonfinite.ts"

/** libsql in memory, seeded */
async function seeded(options: CursorOptions = SEALED) {
	const harness = libsqlMemory()
	for (const statement of SEED) await harness.client.execute(statement)
	const engine: Engine = {
		exec: async (statement) => {
			await harness.client.execute(statement)
		},
		ids: async (query) => (await harness.client.execute(query)).rows.map((row) => Number(row[0])),
	}
	const db = drizzle({ client: harness.client, relations: pointRelations })
	return {
		close: harness.close,
		engine,
		pages: {
			buildListQuery: viaBuilder(harness.db as never, options),
			listOptions: viaRelational(db as never, options),
		},
	}
}

describe("keyset pagination on ±Infinity and NULL in a SQLite REAL, on libsql (R4, U4)", () => {
	for (const via of ["buildListQuery", "listOptions"] as const) {
		for (const edit of [undefined, "delete", "set to 5"] as Array<Edit | undefined>) {
			it.each(ORDERS)(
				`pages %s through ${via} every row once${edit ? `, its NULL anchor's row ${edit}` : ""}`,
				async (order) => {
					const { close, engine, pages } = await seeded()
					try {
						const { expected, seen } = await pageAll(engine, pages[via], { edit, order })
						expect(seen).toEqual(expected)
					} finally {
						close()
					}
				},
			)
		}
	}
})

/* U24: libsql reads ±Infinity back as Infinity, so with nonFinite "exact" a null cursor is a real NULL */
describe("keyset pagination on libsql with nonFinite exact: a deleted NULL anchor (U24)", () => {
	for (const via of ["buildListQuery", "listOptions"] as const) {
		it.each(ORDERS)(`pages %s through ${via} resuming right after it, no row repeated`, async (order) => {
			const { close, engine, pages } = await seeded({ ...SEALED, nonFinite: "exact" })
			try {
				const { expected, seen } = await pageAll(engine, pages[via], { edit: "delete", exact: true, order })
				expect(seen).toEqual(expected)
				expect(new Set(seen).size).toBe(seen.length)
			} finally {
				close()
			}
		})
	}
})
