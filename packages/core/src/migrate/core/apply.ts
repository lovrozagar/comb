/**
 * Core migration application logic
 */
import type { Connection, ExtractedSchema, MigrationResult, ParsedMigration } from "../types.ts"

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

/* ═══════════════════════════════════════════════════════════════════════════
   SCHEMA VERIFICATION
   ═══════════════════════════════════════════════════════════════════════════ */

/** The columns `table` lacks, or null when the table itself is missing */
async function missingColumns(conn: Connection, table: string, expected: readonly string[]): Promise<string[] | null> {
	const tableCheck = await conn.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [table])
	if (tableCheck.rows.length === 0) return null
	if (expected.length === 0) return []
	const colResult = await conn.execute(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
	const actual = new Set(colResult.rows.map((r) => r[1] as string))
	return expected.filter((column) => !actual.has(column))
}

async function missingIndexes(conn: Connection, expected: readonly string[]): Promise<string[]> {
	if (expected.length === 0) return []
	const placeholders = expected.map(() => "?").join(",")
	const result = await conn.execute(`SELECT name FROM sqlite_master WHERE type='index' AND name IN (${placeholders})`, [
		...expected,
	])
	const found = new Set(result.rows.map((r) => r[0] as string))
	return expected.filter((index) => !found.has(index))
}

/**
 * Whether the database holds the tables, columns and indexes a migration creates. A database
 * error is thrown, not reported as a mismatch: a mismatch makes the caller apply the migration.
 */
export async function verifySchema(
	conn: Connection,
	expected: ExtractedSchema,
): Promise<{ ok: boolean; found: number; errors: string[] }> {
	const errors: string[] = []
	let found = 0
	for (const [tableName, expectedColumns] of Array.from(expected.tables)) {
		const missing = await missingColumns(conn, tableName, expectedColumns)
		if (missing === null) {
			errors.push(`Missing table: ${tableName}`)
			continue
		}
		found++
		if (missing.length > 0) errors.push(`${tableName} missing columns: ${missing.join(", ")}`)
	}
	const indexes = await missingIndexes(conn, expected.indexes)
	if (indexes.length > 0) errors.push(`Missing indexes: ${indexes.join(", ")}`)
	return { errors, found, ok: errors.length === 0 }
}

/* ═══════════════════════════════════════════════════════════════════════════
   APPLY MIGRATION
   ═══════════════════════════════════════════════════════════════════════════ */

export async function applyMigration(
	conn: Connection,
	dbName: string,
	migration: ParsedMigration,
): Promise<MigrationResult> {
	await ensureMigrationsTable(conn)

	/* Check current state */
	const hashExists = await checkMigrationHash(conn, migration.hash)
	const preVerify = await verifySchema(conn, migration.expected)

	/* Case A: Already applied and verified */
	if (hashExists && preVerify.ok) {
		return { database: dbName, status: "already_applied", tablesVerified: preVerify.found }
	}

	/* Case B: Schema correct but hash missing - just record hash */
	if (!hashExists && preVerify.ok && migration.expected.tables.size > 0) {
		await recordMigrationHash(conn, migration.hash)
		return { database: dbName, status: "repaired", tablesVerified: preVerify.found }
	}

	/* Case C: Hash exists but schema wrong - remove bad hash */
	if (hashExists && !preVerify.ok) {
		await conn.execute("DELETE FROM __drizzle_migrations WHERE hash = ?", [migration.hash])
	}

	/* Apply migration atomically in single batch */
	const batchStatements = [
		...migration.statements.map((stmt) => ({ sql: stmt })),
		{
			params: [migration.hash, Date.now()],
			sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
		},
	]

	await conn.batch(batchStatements)

	/* Verify after migration */
	const postVerify = await verifySchema(conn, migration.expected)
	if (!postVerify.ok) {
		throw new Error(`Verification failed: ${postVerify.errors.join("; ")}`)
	}

	return { database: dbName, status: "success", tablesVerified: postVerify.found }
}

/* ═══════════════════════════════════════════════════════════════════════════
   BACKUP TABLES (for unsafe migrations)
   ═══════════════════════════════════════════════════════════════════════════ */

export async function createBackupTables(
	conn: Connection,
	tablesToBackup: string[],
): Promise<{ backupSql: string[]; restoreSql: string[] }> {
	const timestamp = Date.now()
	const backupSql: string[] = []
	const restoreSql: string[] = []

	for (const tableName of tablesToBackup) {
		const backupName = `_backup_${tableName}_${timestamp}`

		/* Check if table exists */
		const exists = await conn.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [tableName])

		if (exists.rows.length > 0) {
			backupSql.push(`CREATE TABLE ${backupName} AS SELECT * FROM ${tableName}`)
			restoreSql.push(`DROP TABLE IF EXISTS ${tableName}`)
			restoreSql.push(`ALTER TABLE ${backupName} RENAME TO ${tableName}`)
		}
	}

	/* Execute backup */
	for (const sql of backupSql) {
		await conn.execute(sql)
	}

	return { backupSql, restoreSql }
}

/** Drop the backup tables older than `olderThanMs`; returns how many it dropped */
export async function cleanupBackupTables(conn: Connection, olderThanMs: number = 86400000): Promise<number> {
	const cutoff = Date.now() - olderThanMs
	/* GLOB, because LIKE reads `_` as any character */
	const result = await conn.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '_backup_*'`)
	const stale = result.rows
		.map((row) => row[0] as string)
		.filter((name) => Number(/_(\d+)$/.exec(name)?.[1] ?? Number.POSITIVE_INFINITY) < cutoff)
	for (const name of stale) await conn.execute(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`)
	return stale.length
}
