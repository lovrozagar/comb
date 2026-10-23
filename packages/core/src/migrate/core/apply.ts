/**
 * comb's own migration record on SQLite: the `__drizzle_migrations` table, the hashes in it and,
 * from 0.11, each file's name beside its hash, so an applied file edited since is told from a new one;
 * from 0.13 the name, not the hash, is unique, so two files of one text are recorded apart
 */
import type { Connection } from "../types.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   MIGRATIONS TABLE
   ═══════════════════════════════════════════════════════════════════════════ */

/* comb's history from 0.13: a name is recorded once, a hash as often as files hold that text (M16) */
const TABLE = `(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      name TEXT UNIQUE
    )`

/** Whether a unique index of comb's history holds its hash alone, as comb's table did before 0.13 */
export async function hashUnique(conn: Connection): Promise<boolean> {
	const list = await conn.execute("PRAGMA index_list(__drizzle_migrations)")
	const unique = list.rows.filter((row) => Number(row[list.columns.indexOf("unique")]) === 1)
	for (const index of unique) {
		const name = String(index[list.columns.indexOf("name")])
		const info = await conn.execute(`PRAGMA index_info("${name.replaceAll('"', '""')}")`)
		const columns = info.rows.map((row) => String(row[info.columns.indexOf("name")]))
		if (columns.length === 1 && columns[0] === "hash") return true
	}
	return false
}

/**
 * comb's history, made where it is missing, named from 0.11, and from a history before 0.13
 * rebuilt in one batch: every row and id kept, each row `renamed` lists taking its new name (M35),
 * and the AUTOINCREMENT counter kept above every id it handed out (M36)
 */
export async function ensureMigrationsTable(
	conn: Connection,
	renamed: ReadonlyArray<{ id: number; name: string }> = [],
): Promise<void> {
	await conn.execute(`CREATE TABLE IF NOT EXISTS __drizzle_migrations ${TABLE}`)
	/* a history from before 0.11 gains the column; drizzle's own migrator ignores it */
	/* PRAGMA table_info answers in rows, since a driver may name no columns for an empty result */
	const { columns, rows } = await conn.execute("PRAGMA table_info(__drizzle_migrations)")
	const named = rows.some((row) => row[columns.indexOf("name")] === "name")
	if (!named) await conn.execute("ALTER TABLE __drizzle_migrations ADD COLUMN name TEXT")
	/* a history from before 0.13 holds each hash once: rebuilt, in one batch, with every row and id kept */
	if (!(await hashUnique(conn))) return
	/* a history made without AUTOINCREMENT has no counter; its largest id is where the new one starts */
	const sequenced = await conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'")
	const counted =
		sequenced.rows.length === 0
			? "0"
			: "coalesce((SELECT seq FROM sqlite_sequence WHERE name = '__drizzle_migrations'), 0)"
	const counter = await conn.execute(`SELECT max(${counted}, coalesce((SELECT max(id) FROM __drizzle_migrations), 0))`)
	const seq = Number(counter.rows[0]?.[0])
	await conn.batch([
		{ sql: `CREATE TABLE __drizzle_migrations_next ${TABLE}` },
		{
			sql: "INSERT INTO __drizzle_migrations_next (id, hash, created_at, name) SELECT id, hash, created_at, name FROM __drizzle_migrations",
		},
		...renamed.map(({ id, name }) => ({
			params: [name, id],
			sql: "UPDATE __drizzle_migrations_next SET name = ? WHERE id = ?",
		})),
		{ sql: "DROP TABLE __drizzle_migrations" },
		{ sql: "ALTER TABLE __drizzle_migrations_next RENAME TO __drizzle_migrations" },
		{ sql: "DELETE FROM sqlite_sequence WHERE name = '__drizzle_migrations'" },
		{ params: [seq], sql: "INSERT INTO sqlite_sequence (name, seq) VALUES ('__drizzle_migrations', ?)" },
	])
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
