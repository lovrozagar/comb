/**
 * AB3-2 of area B on D1: a SQLite boolean column holding anything but 0 or 1. A list that reads
 * its key back from the anchor row pages it in SQLite's order; one that binds the key as read answers
 * a 500 naming it, never a repeated or skipped row (support/boolean-keys.ts).
 */
import { drizzle } from "drizzle-orm/d1"
import { afterEach, describe, expect, it } from "vitest"
import { type D1Harness, d1Memory } from "../support/d1.ts"
import {
	BOOLEAN_RELATIONS,
	BOOLEAN_SEED,
	BOOLEAN_SERVED,
	BOOLEAN_WALKS,
	type BooleanShape,
	servedBooleans,
} from "../support/boolean-keys.ts"
import { startsOrder } from "../support/text-timestamps.ts"

const shards: D1Harness[] = []
afterEach(async () => {
	await Promise.all(shards.splice(0).map((shard) => shard.dispose()))
})

/** A database seeded with `statements` */
async function holding(statements: readonly string[]) {
	const shard = await d1Memory()
	shards.push(shard)
	for (const statement of statements) await shard.CORE.prepare(statement).run()
	return drizzle(shard.CORE, { relations: BOOLEAN_RELATIONS })
}

/** One database, or two shards for the merged list */
const dbsFor = async (shape: BooleanShape) =>
	shape === "merged"
		? [await holding(BOOLEAN_SEED(0)), await holding(BOOLEAN_SEED(1))]
		: [await holding(BOOLEAN_SEED())]

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
