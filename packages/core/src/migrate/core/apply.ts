/**
 * comb's own migration record on SQLite: the `__drizzle_migrations` table, the hashes in it and,
 * from 0.11, each file's name beside its hash, so an applied file edited since is told from a new one
 */
import type { Connection } from "../types.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   MIGRATIONS TABLE
   ═══════════════════════════════════════════════════════════════════════════ */

export async function ensureMigrationsTable(conn: Connection): Promise<void> {
	await conn.execute(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      name TEXT
    )
  `)
	/* a history from before 0.11 gains the column; drizzle's own migrator ignores it */
	/* PRAGMA table_info answers in rows, since a driver may name no columns for an empty result */
	const { columns, rows } = await conn.execute("PRAGMA table_info(__drizzle_migrations)")
	const named = rows.some((row) => row[columns.indexOf("name")] === "name")
	if (!named) await conn.execute("ALTER TABLE __drizzle_migrations ADD COLUMN name TEXT")
}

/**
 * Whether a migration is recorded under any of `hashes`; pass `migrationHashes(sql)` so a file
 * recorded under the pre-0.5.0 hash still counts as applied.
 */
export async function checkMigrationHash(conn: Connection, hashes: string | readonly string[]): Promise<boolean> {
	const list = typeof hashes === "string" ? [hashes] : [...hashes]
	const marks = list.map(() => "?").join(", ")
	const result = await conn.execute(`SELECT hash FROM __drizzle_migrations WHERE hash IN (${marks})`, list)
	return result.rows.length > 0
}

/** Record `hash` as applied, under the file's `name` when given (an unnamed row is named on the next apply) */
export async function recordMigrationHash(conn: Connection, hash: string, name?: string): Promise<void> {
	await conn.execute("INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)", [
		hash,
		Date.now(),
		name ?? null,
	])
}
