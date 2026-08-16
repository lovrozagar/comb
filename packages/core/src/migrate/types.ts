/**
 * Core types for db-migration package
 */
import * as z from "zod"

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
   PROVIDER CONFIGS
   ═══════════════════════════════════════════════════════════════════════════ */

export const tursoProviderConfigSchema = z.object({
	apiToken: z.string().min(1),
	group: z.string().min(1),
	org: z.string().min(1),
	type: z.literal("turso"),
})

export const libsqlProviderConfigSchema = z.object({
	authToken: z.string().optional(),
	type: z.literal("libsql"),
	url: z.string().min(1),
})

export const bunSqliteProviderConfigSchema = z.object({
	path: z.string().min(1),
	type: z.literal("bun-sqlite"),
})

export const postgresProviderConfigSchema = z.object({
	connectionString: z.string().min(1),
	type: z.literal("postgres"),
})

export const neonProviderConfigSchema = z.object({
	connectionString: z.string().min(1),
	type: z.literal("neon"),
})

export const d1ProviderConfigSchema = z.object({
	databaseId: z.string().min(1),
	databaseName: z.string().min(1),
	type: z.literal("d1"),
})

export const providerConfigSchema = z.discriminatedUnion("type", [
	tursoProviderConfigSchema,
	libsqlProviderConfigSchema,
	bunSqliteProviderConfigSchema,
	postgresProviderConfigSchema,
	neonProviderConfigSchema,
	d1ProviderConfigSchema,
])

export type TursoProviderConfig = z.infer<typeof tursoProviderConfigSchema>
export type LibsqlProviderConfig = z.infer<typeof libsqlProviderConfigSchema>
export type BunSqliteProviderConfig = z.infer<typeof bunSqliteProviderConfigSchema>
export type PostgresProviderConfig = z.infer<typeof postgresProviderConfigSchema>
export type NeonProviderConfig = z.infer<typeof neonProviderConfigSchema>
export type D1ProviderConfig = z.infer<typeof d1ProviderConfigSchema>
export type ProviderConfig = z.infer<typeof providerConfigSchema>

/* ═══════════════════════════════════════════════════════════════════════════
   ENVIRONMENT CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

export const environmentConfigSchema = z.object({
	name: z.string().min(1),
	provider: providerConfigSchema.optional(),
})

export type EnvironmentConfig = z.infer<typeof environmentConfigSchema> & {
	provider?: ProviderConfig | undefined
}

/* ═══════════════════════════════════════════════════════════════════════════
   DATABASE CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

export const databaseConfigSchema = z.object({
	drizzleConfigPath: z.string().optional(),
	environments: z.record(z.string(), environmentConfigSchema).optional(),
	migrationsDir: z.string().min(1),
	provider: providerConfigSchema.optional(),
})

export type DatabaseConfig = z.infer<typeof databaseConfigSchema> & {
	name?: string | undefined
	promotionOrder?: string[]
	provider?: ProviderConfig | undefined
	environments?: Record<string, EnvironmentConfig> | undefined
}

/* Resolved database config for a specific environment */
export type ResolvedDatabaseConfig = {
	name: string
	migrationsDir: string
	drizzleConfigPath?: string | undefined
	provider: ProviderConfig
}

/* ═══════════════════════════════════════════════════════════════════════════
   MULTI-TENANT CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

export const multiTenantConfigSchema = z.object({
	circuitBreaker: z
		.object({
			failureThreshold: z.number().min(0).max(1).default(0.1),
			minSampleSize: z.number().int().min(1).default(50),
		})
		.default(() => ({ failureThreshold: 0.1, minSampleSize: 50 })),
	concurrency: z.number().int().min(1).max(200).default(50),
	enabled: z.literal(true),
	rootDatabase: z.string().min(1),
	tenantQuery: z.string().min(1),
})

export type MultiTenantConfig = z.infer<typeof multiTenantConfigSchema>

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
	unsafeStatements: string[]
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
