/**
 * comb's own migration record on SQLite: the `__drizzle_migrations` table and the hashes in it
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
      created_at INTEGER NOT NULL
    )
  `)
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

export async function recordMigrationHash(conn: Connection, hash: string): Promise<void> {
	await conn.execute("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [hash, Date.now()])
}
