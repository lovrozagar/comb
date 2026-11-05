/**
 * B2-3 of area B on libsql: TEXT in a SQLite timestamp column, which SQLite orders after every number.
 * A list that reads its key back from the anchor row pages it in SQLite's order; one that binds the
 * key as read answers a 500 naming it, never a repeated or skipped row (support/text-timestamps.ts).
 */
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it } from "vitest"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"
import {
	FRACTION_SEED,
	HUGE_SEED,
	HUGE_SERVED,
	INFINITY_SEED,
	INFINITY_SERVED,
	FRACTION_SERVED,
	firstCursor,
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

const shards: LibsqlHarness[] = []
afterEach(async () => {
	for (const shard of shards.splice(0)) shard.close()
})

/** A database seeded with `statements` */
async function holding(statements: readonly string[]) {
	const shard = libsqlMemory()
	shards.push(shard)
	for (const statement of statements) await shard.client.execute(statement)
	return drizzle({ client: shard.client, relations: TEXT_RELATIONS })
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

/*
 * B2-6 of area B: a list that binds a SQLite timestamp key as read carries the number it stores, and
 * readCursor returned that number where the list's row read a Date; it returns the row's Date on every
 * list, an Invalid Date for a TEXT no Date holds, while the cursor pages by the stored value
 */
describe("readCursor returns a SQLite timestamp key as the row read it (B2-6 of area B; sibling: AB3's seconds)", () => {
	it.each(["anchorless", "anchored joined", "merged", "table", "anchored own", "listOptions"] as const)(
		"returns the %s list's key as the Date its row read",
		async (shape) => {
			for (const key of ["m", "s"] as const) {
				const cursor = await firstCursor(await dbsFor(shape, FRACTION_SEED), { direction: "asc", key, shape })
				expect(cursor.values, key).toEqual([new Date(key === "s" ? -1500 : -1)])
				expect(cursor.carried, key).toEqual([false])
			}
		},
	)

	it.each(["table", "anchored own", "listOptions"] as const)(
		"returns the %s list's TEXT key as the Invalid Date its row read",
		async (shape) => {
			for (const key of ["m", "s"] as const) {
				const { values } = await firstCursor(await dbsFor(shape), { direction: "desc", key, shape })
				expect(values[0], key).toBeInstanceOf(Date)
				expect((values[0] as Date).getTime(), key).toBeNaN()
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

/* AB4-7 of area B: libsql's cast(k as text) keeps 15 digits, so a list carries the printf text that reads back */
describe("a SQLite timestamp's REAL pages exactly by the text of it that reads back, on libsql (AB4-7 of area B)", () => {
	it.each(["table", "anchored own", "anchored joined", "anchorless", "listOptions", "merged"] as const)(
		"pages the %s list past 1e300 and 1e-300, and a REAL D1 prints in no text that reads back, every row once",
		async (shape) => {
			for (const walk of WALKS) {
				expect(await servedText(await dbsFor(shape, HUGE_SEED), { ...walk, shape }), JSON.stringify(walk)).toEqual({
					ids: HUGE_SERVED[walk.direction],
				})
				expect(await servedText(await dbsFor(shape, UNPRINTED_SEED), { ...walk, shape }), JSON.stringify(walk)).toEqual(
					{
						ids: UNPRINTED_SERVED[walk.direction],
					},
				)
			}
		},
	)
})
