/**
 * B2-3 of area B on D1: TEXT in a SQLite timestamp column, which SQLite orders after every number.
 * A list that reads its key back from the anchor row pages it in SQLite's order; one that binds the
 * key as read answers a 500 naming it, never a repeated or skipped row (support/text-timestamps.ts).
 */
import { afterEach, describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { type D1Harness, d1Memory } from "../support/d1.ts"
import {
	FRACTION_SEED,
	HUGE_SEED,
	HUGE_SERVED,
	INFINITY_SEED,
	INFINITY_SERVED,
	FRACTION_SERVED,
	firstPage,
	firstPair,
	LEADING_SEED,
	startsOrder,
	TEXT_RELATIONS,
	TEXT_SEED,
	TEXT_SERVED,
	UNPRINTED_SEED,
	UNPRINTED_SERVED,
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

/** One database, or two shards for the merged list, seeded by `seed` */
const dbsFor = async (shape: TextShape, seed = TEXT_SEED) =>
	shape === "merged" ? [await holding(seed(0)), await holding(seed(1))] : [await holding(seed())]

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
					cause: expect.stringContaining(`${walk.key satisfies TextKey} stores a TEXT value`),
					errorKey: "sort_not_wired",
					status: 500,
				})
				expect(startsOrder(ids, TEXT_SERVED[walk.direction]), `${JSON.stringify(walk)} ${ids}`).toBe(true)
			}
		},
	)
})

/* B2-6 of area B: a Date keeps a stored millisecond's integer part only, so a list bound by it repeated or skipped */
describe("a SQLite timestamp holding a fraction of its unit pages exactly on every list (B2-6 of area B; sibling: AB3's seconds)", () => {
	it.each(["table", "anchored own", "anchored joined", "anchorless", "listOptions", "merged"] as const)(
		"pages the %s list by milliseconds and seconds below the unit, every row once",
		async (shape) => {
			for (const walk of WALKS) {
				const served = await servedText(await dbsFor(shape, FRACTION_SEED), { ...walk, shape })
				expect(served, JSON.stringify(walk)).toEqual({ ids: FRACTION_SERVED[walk.direction] })
			}
		},
	)
})

/* AB3-1 of area B: a list that binds the key as read carried ±Infinity as the text 'Inf', which no cursor reads back */
describe("a SQLite timestamp holding ±Infinity pages every row once on every list (AB3-1 of area B)", () => {
	it.each(["table", "anchored own", "anchored joined", "anchorless", "listOptions", "merged"] as const)(
		"pages the %s list by milliseconds and seconds past every finite time, every row once",
		async (shape) => {
			for (const walk of WALKS) {
				const served = await servedText(await dbsFor(shape, INFINITY_SEED), { ...walk, shape })
				expect(served, JSON.stringify(walk)).toEqual({ ids: INFINITY_SERVED[walk.direction] })
			}
		},
	)
})

/* AB3-5 of area B: a list that binds the key as read refused a TEXT row only when it ended a page */
describe("a TEXT row is refused on the page that serves it, wherever it lands (AB3-5 of area B; sibling: B2-3's refusal)", () => {
	it.each(["anchorless", "anchored joined", "merged"] as const)(
		"answers the %s list a 500 naming the key on the page a TEXT row leads and a number ends",
		async (shape) => {
			for (const key of ["s", "m"] as const)
				expect(
					(await firstPair(await dbsFor(shape, LEADING_SEED), { direction: "desc", key, shape })).error,
					key,
				).toMatchObject({
					cause: expect.stringContaining(`${key} stores a TEXT value`),
					errorKey: "sort_not_wired",
					status: 500,
				})
		},
	)

	it.each(["table", "anchored own", "listOptions"] as const)(
		"serves the %s list's page as it reads the key back",
		async (shape) => {
			for (const key of ["s", "m"] as const)
				expect(await firstPair(await dbsFor(shape, LEADING_SEED), { direction: "desc", key, shape }), key).toEqual({
					ids: ["d", "a"],
				})
		},
	)
})

/* AB4-7 of area B: D1 prints some REALs in no text that reads back, and binds a JS number of others as another */
describe("a SQLite timestamp's REAL pages exactly where a text of it reads back, on D1 (AB4-7 of area B)", () => {
	it.each(["table", "anchored own", "anchored joined", "anchorless", "listOptions", "merged"] as const)(
		"pages the %s list past 1e300, which printf misprints, and 1e-300, which a JS number misses, every row once",
		async (shape) => {
			for (const walk of WALKS) {
				const served = await servedText(await dbsFor(shape, HUGE_SEED), { ...walk, shape })
				expect(served, JSON.stringify(walk)).toEqual({ ids: HUGE_SERVED[walk.direction] })
			}
		},
	)

	it.each(["anchorless", "anchored joined", "merged"] as const)(
		"answers the %s list a 500 naming the key on the page that serves a REAL no text reads back as",
		async (shape) => {
			for (const walk of WALKS) {
				const { error, ids } = await servedText(await dbsFor(shape, UNPRINTED_SEED), { ...walk, shape })
				expect(error, JSON.stringify(walk)).toMatchObject({
					cause: expect.stringContaining(`${walk.key} holds a REAL no text SQLite prints of it reads back as`),
					errorKey: "sort_not_wired",
					status: 500,
				})
				expect(ids, JSON.stringify(walk)).toEqual(walk.direction === "asc" ? ["a", "c"] : [])
			}
		},
	)

	it.each(["table", "anchored own", "listOptions"] as const)(
		"pages the %s list by its rows, a REAL no text reads back as included",
		async (shape) => {
			for (const walk of WALKS) {
				const served = await servedText(await dbsFor(shape, UNPRINTED_SEED), { ...walk, shape })
				expect(served, JSON.stringify(walk)).toEqual({ ids: UNPRINTED_SERVED[walk.direction] })
			}
		},
	)
})
