/**
 * QL1 and QL2 of r22b on libsql: a key the anchor row can't supply is bound as an anchorless list binds
 * it, and a seconds-mode timestamp's stored seconds are carried exactly. 0.20.1 read a joined table's
 * key "back from the anchor row" through a subquery that correlated to each candidate row, skipping
 * rows, and bound an anchorless seconds key as a Date, looping ascending and skipping descending.
 * libsql reads an integer past 2^53 as a number only by refusing it, so the rounded key is D1's and
 * Postgres's suites' case.
 */
import { afterEach, describe, expect, it } from "vitest"
import { type JoinedKey, SEED, SERVED, SERVED_NULLS, servedBy } from "../support/joined-keys.ts"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"
import { NUMERIC_SEED, NUMERIC_SERVED, servedNumeric } from "../support/numeric-key.ts"

let harness: LibsqlHarness | undefined
afterEach(() => {
	harness?.close()
	harness = undefined
})

async function seeded() {
	harness = libsqlMemory()
	for (const statement of SEED) await harness.client.execute(statement)
	return harness.db
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
	const shards: LibsqlHarness[] = []
	afterEach(() => {
		for (const shard of shards.splice(0)) shard.close()
	})

	/** A libsql database seeded with `statements` */
	async function holding(statements: readonly string[]) {
		const shard = libsqlMemory()
		shards.push(shard)
		for (const statement of statements) await shard.client.execute(statement)
		return shard.db
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
