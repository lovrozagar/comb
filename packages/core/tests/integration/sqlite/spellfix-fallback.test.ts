/**
 * K1 of r19 on libsql, which loads no spellfix1: buildFtsWhereWithSpellfix searches the terms as
 * typed, through drizzle's DrizzleQueryError, as the README promises. tests/bun and tests/integration/d1
 * run the same on bun:sqlite and D1.
 */
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { describe, expect, it } from "vitest"
import { SEED, searched } from "../support/spellfix.ts"

describe("buildFtsWhereWithSpellfix on libsql, without spellfix1", () => {
	it("searches the terms as typed, its vocabulary table absent as it must be", async () => {
		const client = createClient({ url: ":memory:" })
		try {
			for (const statement of SEED) await client.execute(statement)
			expect(await searched(drizzle({ client }), "hello")).toEqual([1])
			expect(await searched(drizzle({ client }), "hello wor")).toEqual([1])
		} finally {
			client.close()
		}
	})
})
