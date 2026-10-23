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
	/** the prefix of the tables the engine keeps for itself (D1: `_cf_`), which comb never counts or copies */
	ownedPrefix?: string | undefined
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
	databaseName: string
	/** Target the local dev database (`wrangler --local`) instead of the remote one. */
	local?: boolean | undefined
	type: "d1"
	/** The wrangler config that binds the database, relative to comb.migrate.config.ts; default: the one in its folder */
	wranglerConfig?: string | undefined
	/** The wrangler environment (`--env`) the binding is read from and every wrangler command runs in */
	wranglerEnv?: string | undefined
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
	/** the comb.config.ts database this one's tables and FTS are, when its name there is another (C7) */
	codegen?: string | undefined
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
	/** open it read-only, as check and status do: a missing database file is an error, not a new database */
	readonly?: boolean | undefined
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

/** A foreign key as a migration declares it; an empty `parentColumns` is the parent's primary key */
export type ForeignKey = {
	table: string
	columns: string[]
	parent: string
	parentColumns: string[]
	onDelete: "CASCADE" | "NO ACTION" | "RESTRICT" | "SET DEFAULT" | "SET NULL"
}

/** What a table rebuild must know of a table to save and restore its rows */
export type TableInfo = {
	primaryKey: string[]
	/** a WITHOUT ROWID table, whose rows are saved by primary key */
	withoutRowid: boolean
	/** its primary key is the rowid: a lone INTEGER column, so writing the key writes the rowid */
	rowidAlias: boolean
	/** columns no INSERT may write */
	generatedColumns: string[]
	/** SQLite keeps its next id in sqlite_sequence */
	autoincrement: boolean
	/** each column's type affinity by SQLite's rules: INTEGER, TEXT, BLOB, REAL or NUMERIC */
	affinity: Record<string, string>
	/** each ON CONFLICT resolution other than ABORT the table declares, as `<column or key>: <resolution>` */
	conflicts: string[]
	/** a STRICT table, which refuses a value of another type */
	strict: boolean
}

/** A write that fires a trigger */
export type TriggerEvent = "delete" | "insert" | "update"

export type ExtractedSchema = {
	tables: Map<string, string[]>
	indexes: string[]
	droppedTables: string[]
	foreignKeys: ForeignKey[]
	/**
	 * each trigger left, by its table, with the writes that fire it; `ftsSync` when its body only
	 * writes into an external-content FTS5 table (the sync triggers comb writes)
	 */
	triggers: Array<{ events: TriggerEvent[]; ftsSync: boolean; name: string; table: string }>
	/** the FTS5 tables whose text lives elsewhere (`content='src'`, or contentless `content=''`): a drop of one loses nothing */
	externalFts: string[]
	/**
	 * the statements of the history, in order: on Postgres, what its parse tree shows a write runs
	 * (parentage, defaults, rules, operators, casts) is read from them (pg-history.ts)
	 */
	statements: string[]
	tableInfo: Map<string, TableInfo>
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
	/**
	 * the SQLite writes among `unsafeStatements` the classifier could not clear on its own, pending
	 * the proof run's read of what each writes; the proof's findings replace them
	 */
	pendingStatements: string[]
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
