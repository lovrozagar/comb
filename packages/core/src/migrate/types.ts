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
	/**
	 * `statements` in order, as one transaction on SQLite, libsql and bun:sqlite. On D1 they go in order
	 * through wrangler, in no transaction and in as many `--command` calls as one argument's length
	 * needs, so a caller sends only statements that are safe to run again.
	 */
	batch(statements: Array<{ sql: string; params?: unknown[] | undefined }>): Promise<void>
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

/** A Turso database: it names its own database, which the environment's name never does (K2 of r18) */
export type TursoProviderConfig = {
	apiToken: string
	databaseName: string
	/** The placement group a database created on demand joins (default "default") */
	group?: string | undefined
	org: string
	type: "turso"
}

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

/** An environment of a database: its name, its key's unless it gives one (K13), and its provider, the database's unless it gives one */
export type EnvironmentConfig = { name?: string | undefined; provider?: ProviderConfig | undefined }

/** What every database declares, whichever shape it has */
export type DatabaseShared = {
	/** the comb.config.ts database this one's tables and FTS are, when its name there is another (C7) */
	codegen?: string | undefined
	drizzleConfigPath?: string | undefined
	migrationsDir: string
}

/** A database of one target: its name and its provider */
export type SingleDatabaseConfig = DatabaseShared & {
	environments?: undefined
	name: string
	provider: ProviderConfig
}

/** A database of environments, at least one, each resolving to a provider; a provider here is each one's default */
export type EnvironmentsDatabaseConfig = DatabaseShared & {
	environments: Record<string, EnvironmentConfig>
	name?: undefined
	provider?: ProviderConfig | undefined
}

/** A database comb.migrate.config.ts declares: of one target, or of environments, never both (K13 of the 0.15.0 review) */
export type DatabaseConfig = EnvironmentsDatabaseConfig | SingleDatabaseConfig

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
   MIGRATION CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

export type MigrationConfig = {
	databases: Record<string, DatabaseConfig>
}

/* ═══════════════════════════════════════════════════════════════════════════
   MIGRATION RESULT
   ═══════════════════════════════════════════════════════════════════════════ */

export type MigrationStatus = "success" | "already_applied" | "repaired" | "failed" | "skipped"

export type MigrationResult = {
	database: string
	status: MigrationStatus
	tablesVerified?: number | undefined
	error?: string | undefined
}

/* ═══════════════════════════════════════════════════════════════════════════
   CIRCUIT BREAKER
   ═══════════════════════════════════════════════════════════════════════════ */

export type CircuitBreakerState = {
	totalProcessed: number
	failures: number
	tripped: boolean
	tripReason?: string | undefined
}
