/// <reference types="bun-types" />
/**
 * AB3-2 of area B on bun:sqlite: a SQLite boolean column holding anything but 0 or 1. A list that
 * reads its key back from the anchor row pages it in SQLite's order; one that binds the key as read
 * answers a 500 naming it, never a repeated or skipped row. tests/integration/sqlite and
 * tests/integration/d1 run the same on libsql and D1.
 */
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import {
	BOOLEAN_RELATIONS,
	BOOLEAN_SEED,
	BOOLEAN_SERVED,
	BOOLEAN_WALKS,
	type BooleanShape,
	servedBooleans,
} from "../integration/support/boolean-keys.ts"
import { startsOrder } from "../integration/support/text-timestamps.ts"

const clients: Database[] = []
afterEach(() => {
	for (const client of clients.splice(0)) client.close()
})

/** bun:sqlite in memory, seeded with `statements` */
function holding(statements: readonly string[]) {
	const client = new Database(":memory:")
	clients.push(client)
	for (const statement of statements) client.run(statement)
	return drizzle({ client, relations: BOOLEAN_RELATIONS }) as never
}

/** One database, or two shards for the merged list */
const dbsFor = (shape: BooleanShape) =>
	shape === "merged" ? [holding(BOOLEAN_SEED(0)), holding(BOOLEAN_SEED(1))] : [holding(BOOLEAN_SEED())]

describe("a SQLite boolean holding anything but 0 or 1 pages or is refused by name, on bun:sqlite (AB3-2 of area B)", () => {
	it.each(["table", "anchored own", "listOptions"] as const)(
		"pages the %s list in SQLite's order, every row once",
		async (shape) => {
			for (const walk of BOOLEAN_WALKS) {
				const served = await servedBooleans(dbsFor(shape), { ...walk, shape })
				expect(served, JSON.stringify(walk)).toEqual({ ids: [...BOOLEAN_SERVED[walk.direction]] })
			}
		},
	)

	it.each(["anchorless", "anchored joined", "merged"] as const)(
		"answers the %s list a 500 naming the key, never repeating or skipping a row",
		async (shape) => {
			for (const walk of BOOLEAN_WALKS) {
				const { error, ids } = await servedBooleans(dbsFor(shape), { ...walk, shape })
				expect(error, JSON.stringify(walk)).toMatchObject({
					cause: expect.stringContaining("b stores"),
					errorKey: "sort_not_wired",
					status: 500,
				})
				expect(startsOrder(ids, BOOLEAN_SERVED[walk.direction]), `${JSON.stringify(walk)} ${ids}`).toBe(true)
			}
		},
	)
})
