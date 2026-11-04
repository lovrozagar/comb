/**
 * QL1 and QL2 of r22b on D1, whose transport reads a REAL ±Infinity as null: a key the anchor row can't supply is bound as an anchorless list binds
 * it, and a seconds-mode timestamp's stored seconds are carried exactly. 0.20.1 read a joined table's
 * key "back from the anchor row" through a subquery that correlated to each candidate row, skipping
 * rows, and bound an anchorless seconds key as a Date, looping ascending and skipping descending.
 */
import { afterEach, describe, expect, it } from "vitest"
import { type JoinedKey, SEED, SERVED, SERVED_NULLS, servedBy } from "../support/joined-keys.ts"
import { drizzle } from "drizzle-orm/d1"
import { type D1Harness, d1Memory } from "../support/d1.ts"
import { NUMERIC_SEED, NUMERIC_SERVED, servedNumeric } from "../support/numeric-key.ts"

let harness: D1Harness | undefined
afterEach(async () => {
	await harness?.dispose()
	harness = undefined
})

async function seeded() {
	harness = await d1Memory()
	for (const statement of SEED) await harness.CORE.prepare(statement).run()
	return drizzle(harness.CORE)
}

describe("a list key is read back exactly or treated as anchorless (QL1, QL2; sibling: r22 Q1's rounded key)", () => {
	it.each([
		["a REAL ±Infinity", "x"],
		["a seconds-mode timestamp with a fraction below the millisecond", "at"],
	] as Array<[string, JoinedKey]>)("pages a joined %s on a list anchored on post, every row once", async (_, key) => {
		const db = await seeded()
		for (const direction of ["asc", "desc"] as const) {
			expect(await servedBy(db, { direction, key, shape: "anchored own" })).toEqual(SERVED[direction])
			expect(await servedBy(db, { direction, key, shape: "anchored joined" })).toEqual(SERVED[direction])
		}
	})

	it("refuses a joined integer past 2^53 the driver rounded, as an anchorless list does", async () => {
		const db = await seeded()
		for (const direction of ["asc", "desc"] as const) {
			expect(await servedBy(db, { direction, key: "big", shape: "anchored own" })).toEqual(SERVED[direction])
			await expect(servedBy(db, { direction, key: "big", shape: "anchored joined" })).rejects.toMatchObject({
				cause: expect.stringMatching(/^k \d+ is past ±\(2\^53 − 1\), where the driver rounded it/),
				errorKey: "sort_not_wired",
			})
		}
	})

	/* AB5 of area B: QL1's guard keeps a joined key's NULL from the anchor row's max(), a SQL error there */
	it("pages a joined REAL holding NULL on a list anchored on post, nulls first and last, every row once", async () => {
		const db = await seeded()
		for (const [order, served] of Object.entries(SERVED_NULLS)) {
			const [direction, nulls] = order.split(" ") as ["asc" | "desc", "first" | "last"]
			expect(await servedBy(db, { direction, key: "n", nulls, shape: "anchored joined" }), order).toEqual(served)
			expect(await servedBy(db, { direction, key: "n", nulls, shape: "anchored own" }), order).toEqual(served)
		}
	})

	it("pages an anchorless seconds-mode timestamp with a fraction below the millisecond, every row once", async () => {
		const db = await seeded()
		for (const direction of ["asc", "desc"] as const)
			expect(await servedBy(db, { direction, key: "at", shape: "anchorless" })).toEqual(SERVED[direction])
	})
})

/* B2-4 of area B: a numeric() key read as text, carried as the bigint its integer class reads, refused its own cursor */
describe("a drizzle numeric() key pages with no anchor and merged (B2-4 of area B; sibling: QL1's anchorless list)", () => {
	const shards: D1Harness[] = []
	afterEach(async () => {
		await Promise.all(shards.splice(0).map((shard) => shard.dispose()))
	})

	/** A D1 database seeded with `statements` */
	async function holding(statements: readonly string[]) {
		const shard = await d1Memory()
		shards.push(shard)
		for (const statement of statements) await shard.CORE.prepare(statement).run()
		return drizzle(shard.CORE)
	}

	it("pages a numeric() key holding a fraction and integers on the anchorless and the merged list, every row once", async () => {
		const one = [await holding(NUMERIC_SEED())]
		const two = [await holding(NUMERIC_SEED(0)), await holding(NUMERIC_SEED(1))]
		for (const direction of ["asc", "desc"] as const) {
			expect(await servedNumeric(one, { direction, shape: "anchorless" }), direction).toEqual(NUMERIC_SERVED[direction])
			expect(await servedNumeric(two, { direction, shape: "merged" }), direction).toEqual(NUMERIC_SERVED[direction])
		}
	})
})
