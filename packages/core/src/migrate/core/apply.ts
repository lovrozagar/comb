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

export async function checkMigrationHash(conn: Connection, hash: string): Promise<boolean> {
	const result = await conn.execute("SELECT hash FROM __drizzle_migrations WHERE hash = ?", [hash])
	return result.rows.length > 0
}

export async function recordMigrationHash(conn: Connection, hash: string): Promise<void> {
	await conn.execute("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [hash, Date.now()])
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCHEMA VERIFICATION
   ═══════════════════════════════════════════════════════════════════════════ */

export async function verifySchema(
	conn: Connection,
	expected: ExtractedSchema,
): Promise<{ ok: boolean; found: number; errors: string[] }> {
	const errors: string[] = []
	let found = 0

	/* Verify tables + columns */
	for (const [tableName, expectedColumns] of Array.from(expected.tables)) {
		try {
			const tableCheck = await conn.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [
				tableName,
			])

			if (tableCheck.rows.length === 0) {
				errors.push(`Missing table: ${tableName}`)
				continue
			}

			found++

			if (expectedColumns.length > 0) {
				const colResult = await conn.execute(`PRAGMA table_info(${tableName})`)
				const actualColumns = new Set(colResult.rows.map((r) => r[1] as string))
				const missingCols = expectedColumns.filter((c) => !actualColumns.has(c))

				if (missingCols.length > 0) {
					errors.push(`${tableName} missing columns: ${missingCols.join(", ")}`)
				}
			}
		} catch (err) {
			errors.push(`Verify error: ${err instanceof Error ? err.message : String(err)}`)
		}
	}

	/* Verify indexes */
	if (expected.indexes.length > 0) {
		try {
			const placeholders = expected.indexes.map(() => "?").join(",")
			const indexResult = await conn.execute(
				`SELECT name FROM sqlite_master WHERE type='index' AND name IN (${placeholders})`,
				expected.indexes,
			)
			const foundIndexes = new Set(indexResult.rows.map((r) => r[0] as string))
			const missingIndexes = expected.indexes.filter((i) => !foundIndexes.has(i))

			if (missingIndexes.length > 0) {
				errors.push(`Missing indexes: ${missingIndexes.join(", ")}`)
			}
		} catch (err) {
			errors.push(`Index verify error: ${err instanceof Error ? err.message : String(err)}`)
		}
	}

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

export async function cleanupBackupTables(conn: Connection, olderThanMs: number = 86400000): Promise<number> {
	const cutoff = Date.now() - olderThanMs

	const result = await conn.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '_backup_%'`)

	let cleaned = 0
	for (const row of result.rows) {
		const name = row[0] as string
		const match = name.match(/_backup_.+_(\d+)$/)
		if (match?.[1]) {
			const timestamp = parseInt(match[1], 10)
			if (timestamp < cutoff) {
				await conn.execute(`DROP TABLE IF EXISTS ${name}`)
				cleaned++
			}
		}
	}

	return cleaned
}
