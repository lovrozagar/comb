/**
 * B2-3 of area B on D1: TEXT in a SQLite timestamp column, which SQLite orders after every number.
 * A list that reads its key back from the anchor row pages it in SQLite's order; one that binds the
 * key as read answers a 500 naming it, never a repeated or skipped row (support/text-timestamps.ts).
 */
import { afterEach, describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { type D1Harness, d1Memory } from "../support/d1.ts"
import {
	firstPage,
	startsOrder,
	TEXT_RELATIONS,
	TEXT_SEED,
	TEXT_SERVED,
	type TextKey,
	type TextShape,
	servedText,
} from "../support/text-timestamps.ts"

const shards: D1Harness[] = []
afterEach(async () => {
	await Promise.all(shards.splice(0).map((shard) => shard.dispose()))
})

/** A database seeded with `statements` */
async function holding(statements: readonly string[]) {
	const shard = await d1Memory()
	shards.push(shard)
	for (const statement of statements) await shard.CORE.prepare(statement).run()
	return drizzle(shard.CORE, { relations: TEXT_RELATIONS })
}

/** One database, or two shards for the merged list */
const dbsFor = async (shape: TextShape) =>
	shape === "merged" ? [await holding(TEXT_SEED(0)), await holding(TEXT_SEED(1))] : [await holding(TEXT_SEED())]

const WALKS = (["s", "m"] as const).flatMap((key) =>
	[false, true].flatMap((deleting) => (["asc", "desc"] as const).map((direction) => ({ deleting, direction, key }))),
)

describe("TEXT in a SQLite timestamp column pages or is refused by name (B2-3 of area B; sibling: AB3's seconds)", () => {
	it.each(["table", "listOptions"] as const)(
		"strips _combTextKeys from the %s page's rows, a TEXT key's row included",
		async (shape) => {
			for (const key of ["s", "m"] as const) {
				const rows = await firstPage(await dbsFor(shape), { direction: "desc", key, shape })
				expect(
					rows.map((row) => row["id"]),
					key,
				).toEqual([TEXT_SERVED.desc[0]])
				expect(rows[0], key).not.toHaveProperty("_combTextKeys")
			}
		},
	)

	it.each(["table", "anchored own", "listOptions"] as const)(
		"pages the %s list in SQLite's order, every row once",
		async (shape) => {
			for (const walk of WALKS) {
				const served = await servedText(await dbsFor(shape), { ...walk, shape })
				expect(served, JSON.stringify(walk)).toEqual({ ids: TEXT_SERVED[walk.direction] })
			}
		},
	)

	it.each(["anchorless", "anchored joined", "merged"] as const)(
		"answers the %s list a 500 naming the key where it would page a TEXT row, never repeating or skipping one",
		async (shape) => {
			for (const walk of WALKS) {
				const { error, ids } = await servedText(await dbsFor(shape), { ...walk, shape })
				expect(error, JSON.stringify(walk)).toMatchObject({
					cause: expect.stringContaining(`${walk.key satisfies TextKey} stores TEXT`),
					errorKey: "sort_not_wired",
					status: 500,
				})
				expect(startsOrder(ids, TEXT_SERVED[walk.direction]), `${JSON.stringify(walk)} ${ids}`).toBe(true)
			}
		},
	)
})
