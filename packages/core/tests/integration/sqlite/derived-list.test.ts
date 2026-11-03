/**
 * QL1 and QL2 of r22b on libsql: a key the anchor row can't supply is bound as an anchorless list binds
 * it, and a seconds-mode timestamp's stored seconds are carried exactly. 0.20.1 read a joined table's
 * key "back from the anchor row" through a subquery that correlated to each candidate row, skipping
 * rows, and bound an anchorless seconds key as a Date, looping ascending and skipping descending.
 * libsql reads an integer past 2^53 as a number only by refusing it, so the rounded key is D1's and
 * Postgres's suites' case.
 */
import { afterEach, describe, expect, it } from "vitest"
import { type JoinedKey, SEED, SERVED, servedBy } from "../support/joined-keys.ts"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"

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

	it("pages an anchorless seconds-mode timestamp with a fraction below the millisecond, every row once", async () => {
		const db = await seeded()
		for (const direction of ["asc", "desc"] as const)
			expect(await servedBy(db, { direction, key: "at", shape: "anchorless" })).toEqual(SERVED[direction])
	})
})
