/**
 * QL1 and QL2 of r22b on D1, whose transport reads a REAL ±Infinity as null: a key the anchor row can't supply is bound as an anchorless list binds
 * it, and a seconds-mode timestamp's stored seconds are carried exactly. 0.20.1 read a joined table's
 * key "back from the anchor row" through a subquery that correlated to each candidate row, skipping
 * rows, and bound an anchorless seconds key as a Date, looping ascending and skipping descending.
 */
import { afterEach, describe, expect, it } from "vitest"
import { type JoinedKey, SEED, SERVED, servedBy } from "../support/joined-keys.ts"
import { drizzle } from "drizzle-orm/d1"
import { type D1Harness, d1Memory } from "../support/d1.ts"

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

	it("pages an anchorless seconds-mode timestamp with a fraction below the millisecond, every row once", async () => {
		const db = await seeded()
		for (const direction of ["asc", "desc"] as const)
			expect(await servedBy(db, { direction, key: "at", shape: "anchorless" })).toEqual(SERVED[direction])
	})
})
