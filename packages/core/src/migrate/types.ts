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

/** The rows one statement answered */
export type QueryResult = {
	/** the column names, in order; on bun:sqlite and D1 they come from the first row, so a result with no rows has none */
	columns: string[]
	/** each row's values, in `columns`' order */
	rows: unknown[][]
}

/** An open connection to one database, which a migrate command runs its statements through */
export type Connection = {
	/** the SQL dialect the database speaks */
	dialect: Dialect
	/**
	 * The rows `sql` answers, with each `?` in it bound to the next of `params`. On D1 the params are
	 * written into the SQL as literals, since wrangler binds none
	 */
	execute(sql: string, params?: unknown[]): Promise<QueryResult>
	/**
	 * `statements` in order, as one transaction on SQLite, libsql and bun:sqlite. On D1 they go in order
	 * through wrangler, in no transaction and in as many `--command` calls as one argument's length
	 * needs, so a caller sends only statements that are safe to run again.
	 */
	batch(
		statements: Array<{
			/** one statement, its `?` placeholders bound to `params` */
			sql: string
			/** the values of `sql`'s placeholders, in order */
			params?: unknown[] | undefined
		}>,
	): Promise<void>
	/** Closes the connection; on D1, which keeps none open, it does nothing */
	close(): Promise<void>
	/** the prefix of the tables the engine keeps for itself (D1: `_cf_`), which comb never counts or copies */
	ownedPrefix?: string | undefined
}

/** How a migrate command opens connections to one database */
export type ConnectionProvider = {
	/** the SQL dialect of the database it connects to */
	dialect: Dialect
	/** A new connection to the database; with `config.readonly`, a missing database is an error, never created */
	connect(config: ResolvedDatabaseConfig): Promise<Connection>
}

/* ═══════════════════════════════════════════════════════════════════════════
   PROVIDER CONFIGS — the shapes config.ts validates and resolves to
   ═══════════════════════════════════════════════════════════════════════════ */

/** A Turso database: it names its own database, which the environment's name never does */
export type TursoProviderConfig = {
	/** a Turso Platform API token, which comb mints the database's short-lived tokens with */
	apiToken: string
	/** the database's name in the org; a command that writes creates it when it is missing */
	databaseName: string
	/** The placement group a database created on demand joins (default "default") */
	group?: string | undefined
	/** the Turso organization the database belongs to */
	org: string
	/** a Turso database */
	type: "turso"
}

/** A libsql database by URL: a local file or a libsql server */
export type LibsqlProviderConfig = {
	/** the token a libsql server takes; a file needs none */
	authToken?: string | undefined
	/** a libsql database */
	type: "libsql"
	/** a `file:` URL, `:memory:`, or a libsql server's URL */
	url: string
}

/** A SQLite file opened with bun:sqlite, when comb runs on Bun */
export type BunSqliteProviderConfig = {
	/** the database file, or `:memory:` */
	path: string
	/** a bun:sqlite database */
	type: "bun-sqlite"
}

/** A Cloudflare D1 database, which comb reaches through the project's wrangler */
export type D1ProviderConfig = {
	/** the D1 database's binding or `database_name` in the wrangler config */
	databaseName: string
	/** Target the local dev database (`wrangler --local`) instead of the remote one. */
	local?: boolean | undefined
	/** a D1 database */
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
	/** a Postgres database */
	type: "postgres"
	/** the database's connection URL */
	url: string
}

/** A Postgres provider with comb's defaults filled in */
export type ResolvedPostgresProviderConfig = {
	/** the dev database Atlas replays migrations on: the one given, else `docker://postgres/17/dev` */
	devUrl: string
	/** the lock wait bound: the one given, else `5s` */
	lockTimeout: string
	/** the schema comb migrates: the one given, else `public` */
	schema: string
	/** a Postgres database */
	type: "postgres"
	/** the database's connection URL */
	url: string
}

/** Any database comb migrates, by its `type` */
export type ProviderConfig = ConnectionProviderConfig | PostgresProviderConfig

/* ═══════════════════════════════════════════════════════════════════════════
   ENVIRONMENT AND DATABASE CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

/** An environment of a database, which `-e` names by its key */
export type EnvironmentConfig = {
	/** the name comb shows for the environment's database in its output and prompts; default: its key */
	name?: string | undefined
	/** where the environment's database is; default: the database's own `provider` */
	provider?: ProviderConfig | undefined
}

/** What every database declares, whichever shape it has */
export type DatabaseShared = {
	/** the comb.config.ts database this one's tables and FTS are, when its name there is another */
	codegen?: string | undefined
	/** the drizzle config comb exports the database's schema from, relative to comb.migrate.config.ts; default: drizzle-kit's own in the working folder */
	drizzleConfigPath?: string | undefined
	/** the folder of the database's migration files, relative to comb.migrate.config.ts */
	migrationsDir: string
}

/** A database of one target: its name and its provider */
export type SingleDatabaseConfig = DatabaseShared & {
	/** none: a database of one target takes no `-e` */
	environments?: undefined
	/** the name comb shows for the database in its output and prompts */
	name: string
	/** where the database is */
	provider: ProviderConfig
}

/** A database of environments, at least one, each resolving to a provider; a provider here is each one's default */
export type EnvironmentsDatabaseConfig = DatabaseShared & {
	/** each environment, by the key `-e` names it with */
	environments: Record<string, EnvironmentConfig>
	/** none: each environment has its own */
	name?: undefined
	/** the provider of each environment that gives none */
	provider?: ProviderConfig | undefined
}

/** A database comb.migrate.config.ts declares: of one target, or of environments, never both */
export type DatabaseConfig = EnvironmentsDatabaseConfig | SingleDatabaseConfig

/** One database, in the environment a command names, as `resolveDatabaseConfig` resolves it */
export type ResolvedDatabaseConfig = {
	/** the name comb shows for it in its output and prompts: the environment's, else the environment's key, else the database's */
	name: string
	/** the folder of its migration files, as the config gives it */
	migrationsDir: string
	/** its drizzle config, as the config gives it */
	drizzleConfigPath?: string | undefined
	/** open it read-only, as check and status do: a missing database file is an error, not a new database */
	readonly?: boolean | undefined
	/** where it is, a Postgres provider with its defaults filled in */
	provider: ConnectionProviderConfig | ResolvedPostgresProviderConfig
}

/* ═══════════════════════════════════════════════════════════════════════════
   MIGRATION CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

/** What comb.migrate.config.ts declares */
export type MigrationConfig = {
	/** each database comb migrates, by the name `comb migrate` takes */
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

/** A circuit breaker over a run across many databases, which `updateCircuitBreaker` advances */
export type CircuitBreakerState = {
	/** the databases counted so far */
	totalProcessed: number
	/** how many of them failed */
	failures: number
	/** the failure rate crossed the threshold, so the run should stop */
	tripped: boolean
	/** the failure rate and threshold it crossed, once tripped */
	tripReason?: string | undefined
}
