/**
 * AB3-2 of area B on libsql: a SQLite boolean column holding anything but 0 or 1. A list that reads
 * its key back from the anchor row pages it in SQLite's order; one that binds the key as read answers
 * a 500 naming it, never a repeated or skipped row (support/boolean-keys.ts). libsql reads in its
 * bigint mode here: its number mode throws on reading the row past 2^53, before any list sees it.
 */
import { type Client, createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it } from "vitest"
import {
	BOOLEAN_RELATIONS,
	BOOLEAN_SEED,
	BOOLEAN_SERVED,
	BOOLEAN_WALKS,
	type BooleanShape,
	firstPair,
	LEADING_SEED,
	servedBooleans,
} from "../support/boolean-keys.ts"
import { startsOrder } from "../support/text-timestamps.ts"

const shards: Client[] = []
afterEach(() => {
	for (const shard of shards.splice(0)) shard.close()
})

/** A database seeded with `statements` */
async function holding(statements: readonly string[]) {
	const client = createClient({ intMode: "bigint", url: ":memory:" })
	shards.push(client)
	for (const statement of statements) await client.execute(statement)
	return drizzle({ client, relations: BOOLEAN_RELATIONS })
}

/** One database, or two shards for the merged list */
const dbsFor = async (shape: BooleanShape, seed = BOOLEAN_SEED) =>
	shape === "merged" ? [await holding(seed(0)), await holding(seed(1))] : [await holding(seed())]

describe("a SQLite boolean holding anything but 0 or 1 pages or is refused by name (AB3-2 of area B)", () => {
	it.each(["table", "anchored own", "listOptions"] as const)(
		"pages the %s list in SQLite's order, every row once",
		async (shape) => {
			for (const walk of BOOLEAN_WALKS) {
				const served = await servedBooleans(await dbsFor(shape), { ...walk, shape })
				expect(served, JSON.stringify(walk)).toEqual({ ids: BOOLEAN_SERVED[walk.direction] })
			}
		},
	)

	it.each(["anchorless", "anchored joined", "merged"] as const)(
		"answers the %s list a 500 naming the key, never repeating or skipping a row",
		async (shape) => {
			for (const walk of BOOLEAN_WALKS) {
				const { error, ids } = await servedBooleans(await dbsFor(shape), { ...walk, shape })
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

/* AB3-5 of area B: a list that binds the key as read refused such a row only when it ended a page */
describe("a boolean row holding a value but 0 or 1 is refused on the page that serves it (AB3-5 of area B; sibling: AB3-2)", () => {
	it.each(["anchorless", "anchored joined", "merged"] as const)(
		"answers the %s list a 500 naming the key on the page such a row leads and a 0 ends",
		async (shape) => {
			expect((await firstPair(await dbsFor(shape, LEADING_SEED), { direction: "asc", shape })).error).toMatchObject({
				cause: expect.stringContaining("b stores"),
				errorKey: "sort_not_wired",
				status: 500,
			})
		},
	)

	it.each(["table", "anchored own", "listOptions"] as const)(
		"serves the %s list's page as it reads the key back",
		async (shape) => {
			expect(await firstPair(await dbsFor(shape, LEADING_SEED), { direction: "asc", shape })).toEqual({
				ids: ["e", "a"],
			})
		},
	)
})
