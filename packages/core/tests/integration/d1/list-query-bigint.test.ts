/**
 * U22 on D1, whose JSON transport reads 9007199254740993 as …992: every order pages each row of an
 * INTEGER key past 2^53 once through both builders, and a tiebreak id past 2^53 mints no cursor.
 * tests/bun runs the same on bun:sqlite's default mode.
 */
import { drizzle } from "drizzle-orm/d1"
import { afterEach, describe, expect, it } from "vitest"
import { CombError } from "../../../src/error.ts"
import {
	bigRelations,
	CREATE,
	EXACTLY,
	EXPECTED,
	IDS,
	KEYS,
	pageAll,
	viaBuilder,
	viaRelational,
} from "../support/bigint.ts"
import { type D1Harness, d1Memory } from "../support/d1.ts"

let harness: D1Harness | undefined
afterEach(async () => {
	await harness?.dispose()
	harness = undefined
})

async function d1(seed: string) {
	harness = await d1Memory()
	await harness.CORE.prepare(CREATE).run()
	await harness.CORE.prepare(seed).run()
	return harness.CORE
}

describe("keyset pagination over an integer key past 2^53, on D1 (U22)", () => {
	for (const via of ["buildListQuery", "listOptions"] as const) {
		it.each(Object.keys(EXPECTED))(`pages %s through ${via} every row once`, async (order) => {
			const database = await d1(KEYS)
			const page =
				via === "buildListQuery"
					? viaBuilder(drizzle(database) as never)
					: viaRelational(drizzle(database, { relations: bigRelations }) as never)
			expect(await pageAll(page, order)).toEqual(EXPECTED[order])
		})
	}

	it("mints no cursor from a tiebreak id past 2^53, naming what reads it exactly", async () => {
		const database = await d1(IDS)
		const refused = await viaBuilder(drizzle(database) as never)("n.asc", undefined).catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(CombError)
		expect((refused as CombError).errorKey).toBe("sort_not_wired")
		expect(String((refused as CombError).cause)).toMatch(EXACTLY)
	})
})
