/// <reference types="bun-types" />
/**
 * K1 of r19 on bun:sqlite, which loads no spellfix1: buildFtsWhereWithSpellfix searches the terms
 * as typed, through drizzle's DrizzleQueryError. tests/integration runs the same on libsql and D1.
 */
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { SEED, searched } from "../integration/support/spellfix.ts"

describe("buildFtsWhereWithSpellfix on bun:sqlite, without spellfix1", () => {
	it("searches the terms as typed", async () => {
		const client = new Database(":memory:")
		for (const statement of SEED) client.run(statement)
		expect(await searched(drizzle({ client }), "hello")).toEqual([1])
		client.close()
	})
})
