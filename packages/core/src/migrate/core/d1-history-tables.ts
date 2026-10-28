/**
 * The tables a D1 database's migration history lives in (M2 of the 0.13.0 consumers review): a tool
 * that empties a database keeps them, rows and all, or every applied file loses what comb knows of
 * it. wrangler's own table records each applied file by name; comb's records the hash each was
 * applied under, which refuses a file applied, then edited; comb's history before 0.8 is what a
 * baseline copies from.
 */

/** wrangler's migrations table where the binding names no `migrations_table` */
export const D1_MIGRATIONS_TABLE = "d1_migrations"

/** comb's record of the hash each D1 file was applied under, which wrangler's table does not keep */
export const D1_HASH_TABLE = "_comb_migration_hashes"

/** comb's migration history before 0.8, which `comb migrate baseline` copies into wrangler's */
export const DRIZZLE_HISTORY_TABLE = "__drizzle_migrations"

/** Every table a D1 database's history is in, the binding's own `migrations_table` first */
export const d1HistoryTables = (migrationsTable: string = D1_MIGRATIONS_TABLE): string[] => [
	migrationsTable,
	D1_HASH_TABLE,
	DRIZZLE_HISTORY_TABLE,
]
