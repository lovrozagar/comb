/**
 * K1 of r19 on D1, which loads no extension: buildFtsWhereWithSpellfix searches the terms as typed,
 * where 0.17 threw the DrizzleQueryError of its spellfix query. D1's authorizer refuses
 * pragma_module_list, so whether spellfix1 is loaded is asked with editdist3, which reads no table.
 */
import { drizzle } from "drizzle-orm/d1"
import { afterEach, describe, expect, it } from "vitest"
import { type D1Harness, d1Memory } from "../support/d1.ts"
import { SEED, searched } from "../support/spellfix.ts"

let harness: D1Harness | undefined
afterEach(async () => {
	await harness?.dispose()
	harness = undefined
})

describe("buildFtsWhereWithSpellfix on D1, without spellfix1", () => {
	it("searches the terms as typed", async () => {
		harness = await d1Memory()
		for (const statement of SEED) await harness.CORE.prepare(statement).run()
		expect(await searched(drizzle(harness.CORE), "hello")).toEqual([1])
	})
})
