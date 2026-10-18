/**
 * Core types for db-migration package. Declarations only: config.ts validates the config.
 */

/* ═══════════════════════════════════════════════════════════════════════════
   DIALECT
   ═══════════════════════════════════════════════════════════════════════════ */

export type Dialect = "sqlite" | "postgres"

/* ═══════════════════════════════════════════════════════════════════════════
   DRIVER INTERFACE
   ═══════════════════════════════════════════════════════════════════════════ */

export type QueryResult = {
	columns: string[]
	rows: unknown[][]
}

export type Connection = {
	dialect: Dialect
	execute(sql: string, params?: unknown[]): Promise<QueryResult>
	batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void>
	close(): Promise<void>
}

export type ConnectionProvider = {
	dialect: Dialect
	connect(config: ResolvedDatabaseConfig): Promise<Connection>
}

/* ═══════════════════════════════════════════════════════════════════════════
   PROVIDER CONFIGS — the shapes config.ts validates and resolves to
   ═══════════════════════════════════════════════════════════════════════════ */

export type TursoProviderConfig = { apiToken: string; group: string; org: string; type: "turso" }

export type LibsqlProviderConfig = { authToken?: string | undefined; type: "libsql"; url: string }

export type BunSqliteProviderConfig = { path: string; type: "bun-sqlite" }

export type D1ProviderConfig = {
	databaseId: string
	databaseName: string
	/** Target the local dev database (`wrangler --local`) instead of the remote one. */
	local?: boolean | undefined
	type: "d1"
}

/** The providers comb opens a connection to and applies migrations through itself */
export type ConnectionProviderConfig =
	| BunSqliteProviderConfig
	| D1ProviderConfig
	| LibsqlProviderConfig
	| TursoProviderConfig

/**
 * A Postgres database, which Atlas diffs and applies: plain Postgres, Neon or Supabase, by URL.
 * Use a direct, non-pooled URL with `sslmode=verify-full` (or `require`).
 */
export type PostgresProviderConfig = {
	/** an empty database Atlas replays migrations on; default `docker://postgres/17/dev` */
	devUrl?: string | undefined
	/** how long a statement waits for a lock before the migration fails, as `5s`, `1500ms` or `0` for no bound; default `5s` */
	lockTimeout?: string | undefined
	/** the one schema comb migrates; default `public` */
	schema?: string | undefined
	type: "postgres"
	url: string
}

/** A Postgres provider with comb's defaults filled in */
export type ResolvedPostgresProviderConfig = {
	devUrl: string
	lockTimeout: string
	schema: string
	type: "postgres"
	url: string
}

export type ProviderConfig = ConnectionProviderConfig | PostgresProviderConfig

/* ═══════════════════════════════════════════════════════════════════════════
   ENVIRONMENT AND DATABASE CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

export type EnvironmentConfig = { name: string; provider?: ProviderConfig | undefined }

export type DatabaseConfig = {
	drizzleConfigPath?: string | undefined
	environments?: Record<string, EnvironmentConfig> | undefined
	migrationsDir: string
	name?: string | undefined
	promotionOrder?: string[]
	provider?: ProviderConfig | undefined
}

/* Resolved database config for a specific environment */
export type ResolvedDatabaseConfig = {
	name: string
	migrationsDir: string
	drizzleConfigPath?: string | undefined
	provider: ConnectionProviderConfig | ResolvedPostgresProviderConfig
}

/* ═══════════════════════════════════════════════════════════════════════════
   MULTI-TENANT CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

export type MultiTenantConfig = {
	circuitBreaker: { failureThreshold: number; minSampleSize: number }
	concurrency: number
	enabled: true
	rootDatabase: string
	tenantQuery: string
}

/* ═══════════════════════════════════════════════════════════════════════════
   MIGRATION CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

export type MigrationConfig = {
	databases: Record<string, DatabaseConfig>
	multiTenant?: MultiTenantConfig | undefined
}

export type ResolvedMigrationConfig = {
	databases: Record<string, ResolvedDatabaseConfig>
	multiTenant?: MultiTenantConfig | undefined
}

/* ═══════════════════════════════════════════════════════════════════════════
   MIGRATION RESULT
   ═══════════════════════════════════════════════════════════════════════════ */

export type MigrationStatus = "success" | "already_applied" | "repaired" | "failed" | "skipped"

export type MigrationResult = {
	database: string
	status: MigrationStatus
	tablesVerified?: number
	error?: string
}

/* ═══════════════════════════════════════════════════════════════════════════
   PARSED MIGRATION
   ═══════════════════════════════════════════════════════════════════════════ */

export type ExtractedSchema = {
	tables: Map<string, string[]>
	indexes: string[]
	droppedTables: string[]
}

export type MigrationSafety = "safe" | "cautious" | "unsafe"

export type MigrationClassification = {
	safety: MigrationSafety
	/** statements that lose data or break deployed code by name */
	unsafeStatements: string[]
	/** statements that drop or change something no row holds, or a file that is not one transaction */
	cautiousStatements: string[]
	/** Postgres statements that block a table while they run, with what to do instead */
	lockWarnings: string[]
}

export type ParsedMigration = {
	sql: string
	hash: string
	filename: string
	statements: string[]
	drops: string[]
	expected: ExtractedSchema
	classification: MigrationClassification
}

/* ═══════════════════════════════════════════════════════════════════════════
   CIRCUIT BREAKER
   ═══════════════════════════════════════════════════════════════════════════ */

export type CircuitBreakerState = {
	totalProcessed: number
	failures: number
	tripped: boolean
	tripReason?: string
}
