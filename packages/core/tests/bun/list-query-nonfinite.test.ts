/// <reference types="bun-types" />
/**
 * Keyset pagination on ±Infinity and NULL in a SQLite REAL, on bun:sqlite (R4, U4): every order
 * pages each row once through both builders, and a NULL-keyed anchor deleted or set to 5 between
 * pages resumes from where its NULL stood. tests/integration runs the same on libsql and D1.
 */
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { ANCHOR_CASES, servedAround } from "../integration/support/seconds-anchor.ts"
import {
	type Edit,
	type Engine,
	ORDERS,
	pageAll,
	pointRelations,
	SEED,
	viaBuilder,
	viaRelational,
} from "../integration/support/nonfinite.ts"

/** bun:sqlite in memory, seeded */
function seeded() {
	const client = new Database(":memory:")
	for (const statement of SEED) client.run(statement)
	const engine: Engine = {
		exec: async (statement) => {
			client.run(statement)
		},
		ids: async (query) =>
			client
				.query<{ id: number }, []>(query)
				.all()
				.map((row) => row.id),
	}
	return {
		client,
		engine,
		pages: {
			buildListQuery: viaBuilder(drizzle({ client }) as never),
			listOptions: viaRelational(drizzle({ client, relations: pointRelations }) as never),
		},
	}
}

describe("keyset pagination on ±Infinity and NULL in a SQLite REAL, on bun:sqlite (R4, U4)", () => {
	for (const via of ["buildListQuery", "listOptions"] as const) {
		for (const edit of [undefined, "delete", "set to 5"] as Array<Edit | undefined>) {
			for (const order of ORDERS) {
				it(`pages ${order} through ${via} every row once${edit ? `, its NULL anchor's row ${edit}` : ""}`, async () => {
					const { client, engine, pages } = seeded()
					try {
						const { expected, seen } = await pageAll(engine, pages[via], { edit, order })
						expect(seen).toEqual(expected)
					} finally {
						client.close()
					}
				})
			}
		}
	}
})

/* U20 of the 0.13.0 round, on bun:sqlite: the shared seconds-mode cases (support/seconds-anchor.ts) */
describe("keyset pagination on bun:sqlite over a seconds-mode timestamp whose cursor row changes between pages (U20)", () => {
	for (const one of ANCHOR_CASES)
		it(`pages ${one.name} exactly`, async () => {
			const sqlite = new Database(":memory:")
			const engine = {
				db: drizzle({ client: sqlite }) as never,
				exec: async (statement: string) => {
					sqlite.run(statement)
				},
			}
			expect(await servedAround(engine, one)).toEqual(one.want)
			sqlite.close()
		})
})
