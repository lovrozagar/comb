export {
	type CombMigrateConfig,
	createProvider,
	DEFAULT_PG_DEV_URL,
	defineConfig,
	type LoadedConfig,
	loadConfig,
	parseConfig,
	resolveDatabaseConfig,
} from "./config.ts"
export { D1_HASH_TABLE, D1_MIGRATIONS_TABLE, d1HistoryTables, DRIZZLE_HISTORY_TABLE } from "./core/d1-history-tables.ts"
export {
	applySqliteMigrationTransforms,
	checkAtlasInstalled,
	type DrizzleExportOptions,
	exportDrizzleSchema,
	generateSchemaDiff,
	getAtlasVersion,
	type SchemaDiffOptions,
	type SchemaDiffResult,
} from "./core/atlas.ts"
export {
	classifyMigration,
	extractDropStatements,
	extractSchema,
	generateMigrationHash,
	parseMigration,
	splitSqlStatements,
} from "./core/parse.ts"
export { loadPostgresParser } from "./core/pg-parser.ts"
export {
	checkCircuitBreaker,
	createCircuitBreaker,
	type RetryOptions,
	updateCircuitBreaker,
	withRetry,
} from "./core/utils.ts"
export {
	createBunSqliteProvider,
	createD1Provider,
	createLibsqlProvider,
	createTursoProvider,
	getSqliteColumns,
	getSqliteIndexes,
	getSqliteTables,
	getTursoCredentials,
	introspectSqliteSchema,
} from "./drivers/index.ts"
/* what a read-only connect throws for a database that is not there, so a caller can tell it apart */
export { DatabaseMissing } from "./drivers/missing.ts"
export { TursoMissing } from "./drivers/sqlite.ts"
export type {
	ExtractedSchema,
	ForeignKey,
	MigrationClassification,
	MigrationSafety,
	ParsedMigration,
	TableInfo,
	TriggerEvent,
} from "./migration-types.ts"
export type {
	BunSqliteProviderConfig,
	CircuitBreakerState,
	Connection,
	ConnectionProvider,
	ConnectionProviderConfig,
	D1ProviderConfig,
	DatabaseConfig,
	Dialect,
	EnvironmentConfig,
	LibsqlProviderConfig,
	MigrationConfig,
	PostgresProviderConfig,
	ProviderConfig,
	QueryResult,
	ResolvedDatabaseConfig,
	ResolvedPostgresProviderConfig,
	TursoProviderConfig,
} from "./types.ts"
export type { ClassifyOptions } from "./core/classify.ts"
export type { TargetKind } from "./core/classify-target.ts"
export type { DatabaseShared, EnvironmentsDatabaseConfig, SingleDatabaseConfig } from "./types.ts"
export type { FtsObject, FtsState } from "./core/fts-migration.ts"
export type { ProviderDeps } from "./config.ts"
export type { PgTarget } from "./core/atlas-target.ts"
export type { BinPeer, Run, RunOptions, RunResult } from "./core/process.ts"
export type { TursoCredentialsRequest, TursoDeps } from "./drivers/sqlite.ts"
