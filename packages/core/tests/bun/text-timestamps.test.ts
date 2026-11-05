/// <reference types="bun-types" />
/**
 * AB3-1 of area B on bun:sqlite: a seconds- or milliseconds-mode timestamp holding ±Infinity pages
 * every row once on every list kind, both ways. tests/integration/sqlite and tests/integration/d1 run
 * the same on libsql and D1.
 */
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import {
	HUGE_SEED,
	HUGE_SERVED,
	INFINITY_SEED,
	INFINITY_SERVED,
	servedText,
	TEXT_RELATIONS,
	type TextShape,
	UNPRINTED_SEED,
	UNPRINTED_SERVED,
} from "../integration/support/text-timestamps.ts"

const clients: Database[] = []
afterEach(() => {
	for (const client of clients.splice(0)) client.close()
})

/** bun:sqlite in memory, seeded with `statements` */
function holding(statements: readonly string[]) {
	const client = new Database(":memory:")
	clients.push(client)
	for (const statement of statements) client.run(statement)
	return drizzle({ client, relations: TEXT_RELATIONS }) as never
}

/** One database, or two shards for the merged list, seeded by `seed` */
const dbsFor = (shape: TextShape, seed: typeof INFINITY_SEED | typeof HUGE_SEED) =>
	shape === "merged" ? [holding(seed(0)), holding(seed(1))] : [holding(seed())]

const WALKS = (["s", "m"] as const).flatMap((key) =>
	[false, true].flatMap((deleting) => (["asc", "desc"] as const).map((direction) => ({ deleting, direction, key }))),
)

describe("a SQLite timestamp holding ±Infinity pages every row once on every list, on bun:sqlite (AB3-1 of area B)", () => {
	it.each(["table", "anchored own", "anchored joined", "anchorless", "listOptions", "merged"] as const)(
		"pages the %s list by milliseconds and seconds past every finite time, every row once",
		async (shape) => {
			for (const walk of WALKS) {
				const served = await servedText(dbsFor(shape, INFINITY_SEED), { ...walk, shape })
				expect(served, JSON.stringify(walk)).toEqual({ ids: [...INFINITY_SERVED[walk.direction]] })
			}
		},
	)
})

/* AB4-7 of area B: a list carries the text of a REAL that reads back, which bun:sqlite's printf prints exactly */
describe("a SQLite timestamp's REAL pages exactly by the text of it that reads back, on bun:sqlite (AB4-7 of area B)", () => {
	it.each(["table", "anchored own", "anchored joined", "anchorless", "listOptions", "merged"] as const)(
		"pages the %s list past 1e300 and 1e-300, and a REAL D1 prints in no text that reads back, every row once",
		async (shape) => {
			for (const walk of WALKS) {
				expect(await servedText(dbsFor(shape, HUGE_SEED), { ...walk, shape }), JSON.stringify(walk)).toEqual({
					ids: [...HUGE_SERVED[walk.direction]],
				})
				expect(await servedText(dbsFor(shape, UNPRINTED_SEED), { ...walk, shape }), JSON.stringify(walk)).toEqual({
					ids: [...UNPRINTED_SERVED[walk.direction]],
				})
			}
		},
	)
})
