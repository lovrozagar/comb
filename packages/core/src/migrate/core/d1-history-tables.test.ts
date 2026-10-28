import { describe, expect, it } from "vitest"
import { D1_HASH_TABLE, D1_MIGRATIONS_TABLE, d1HistoryTables, DRIZZLE_HISTORY_TABLE } from "../index.ts"

/* M2 of the 0.13.0 consumers review: a tool that empties a D1 database keeps these, rows and all */
describe("d1HistoryTables", () => {
	it("names wrangler's migrations table, comb's record of each file's hash and comb's history before 0.8", () => {
		expect(d1HistoryTables()).toEqual(["d1_migrations", "_comb_migration_hashes", "__drizzle_migrations"])
		expect([D1_MIGRATIONS_TABLE, D1_HASH_TABLE, DRIZZLE_HISTORY_TABLE]).toEqual(d1HistoryTables())
	})

	it("takes the binding's own migrations_table", () => {
		expect(d1HistoryTables("app_migrations")).toEqual([
			"app_migrations",
			"_comb_migration_hashes",
			"__drizzle_migrations",
		])
	})
})
