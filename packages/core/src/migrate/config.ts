/**
 * Standalone configuration for @lovrozagar/comb migrations.
 * No ProjectConfig dependency — accepts a direct CombMigrateConfig object.
 */
import { existsSync } from "fs"
import { resolve } from "path"
import * as z from "zod"
import { createD1Provider } from "./drivers/d1.ts"
import { createNeonProvider, createPostgresProvider } from "./drivers/postgres.ts"
import { createBunSqliteProvider, createLibsqlProvider, createTursoProvider } from "./drivers/sqlite.ts"
import type {
	ConnectionProvider,
	DatabaseConfig,
	MigrationConfig,
	MultiTenantConfig,
	ProviderConfig,
	ResolvedDatabaseConfig,
} from "./types.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIG SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

const providerInputSchema = z.discriminatedUnion("type", [
	z.object({
		apiToken: z.string().min(1),
		group: z.string().min(1).default("default"),
		org: z.string().min(1),
		type: z.literal("turso"),
	}),
	z.object({
		authToken: z.string().optional(),
		type: z.literal("libsql"),
		url: z.string().min(1),
	}),
	z.object({
		path: z.string().min(1),
		type: z.literal("bun-sqlite"),
	}),
	z.object({
		connectionString: z.string().min(1),
		type: z.literal("postgres"),
	}),
	z.object({
		connectionString: z.string().min(1),
		type: z.literal("neon"),
	}),
	z.object({
		databaseId: z.string().min(1),
		databaseName: z.string().min(1),
		type: z.literal("d1"),
	}),
])

const environmentConfigInputSchema = z.object({
	name: z.string().min(1),
	provider: providerInputSchema.optional(),
})

const databaseConfigInputSchema = z.object({
	drizzleConfigPath: z.string().optional(),
	environments: z.record(z.string(), environmentConfigInputSchema).optional(),
	migrationsDir: z.string().min(1),
	name: z.string().min(1).optional(),
	provider: providerInputSchema.optional(),
})

const multiTenantConfigInputSchema = z.object({
	circuitBreaker: z
		.object({
			failureThreshold: z.number().min(0).max(1).default(0.1),
			minSampleSize: z.number().int().min(1).default(50),
		})
		.optional(),
	concurrency: z.number().int().min(1).max(200).default(50),
	enabled: z.literal(true),
	rootDatabase: z.string().min(1),
	tenantQuery: z.string().min(1),
})

const configInputSchema = z.object({
	databases: z.record(z.string(), databaseConfigInputSchema),
	multiTenant: multiTenantConfigInputSchema.optional(),
})

export type CombMigrateConfig = z.infer<typeof configInputSchema>

/* ═══════════════════════════════════════════════════════════════════════════
   RESOLVE PROVIDER CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

function resolveProviderConfig(
	input: NonNullable<z.infer<typeof databaseConfigInputSchema>["provider"]>,
): ProviderConfig {
	switch (input.type) {
		case "turso":
			return { apiToken: input.apiToken, group: input.group, org: input.org, type: "turso" }
		case "libsql":
			return { authToken: input.authToken, type: "libsql", url: input.url }
		case "bun-sqlite":
			return { path: input.path, type: "bun-sqlite" }
		case "postgres":
			return { connectionString: input.connectionString, type: "postgres" }
		case "neon":
			return { connectionString: input.connectionString, type: "neon" }
		case "d1":
			return { databaseId: input.databaseId, databaseName: input.databaseName, type: "d1" }
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   CREATE PROVIDER
   ═══════════════════════════════════════════════════════════════════════════ */

export function createProvider(config: ProviderConfig): ConnectionProvider {
	switch (config.type) {
		case "turso":
			return createTursoProvider(config)
		case "libsql":
			return createLibsqlProvider(config)
		case "bun-sqlite":
			return createBunSqliteProvider(config)
		case "postgres":
			return createPostgresProvider(config)
		case "neon":
			return createNeonProvider(config)
		case "d1":
			return createD1Provider(config)
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   RESOLVE DATABASE CONFIG FOR ENVIRONMENT
   ═══════════════════════════════════════════════════════════════════════════ */

export function resolveDatabaseConfig(dbConfig: DatabaseConfig, envName?: string): ResolvedDatabaseConfig {
	/* New format: environments defined */
	if (dbConfig.environments) {
		if (!envName) {
			throw new Error("Database config has environments but no --env flag provided. Use: --env local|dev|prod")
		}

		const envConfig = dbConfig.environments[envName]
		if (!envConfig) {
			const available = Object.keys(dbConfig.environments).join(", ")
			throw new Error(`Environment "${envName}" not found in config. Available: ${available}`)
		}

		const provider = envConfig.provider ?? dbConfig.provider
		if (!provider) {
			throw new Error(`No provider config for environment "${envName}". Define at database or environment level.`)
		}

		return {
			drizzleConfigPath: dbConfig.drizzleConfigPath,
			migrationsDir: dbConfig.migrationsDir,
			name: envConfig.name,
			provider: resolveProviderConfig(provider),
		}
	}

	/* Legacy format: no environments, single name */
	if (!dbConfig.name) {
		throw new Error("Database config must have either 'name' field or 'environments' object")
	}

	if (!dbConfig.provider) {
		throw new Error("Database config must have 'provider' field when using legacy format")
	}

	return {
		drizzleConfigPath: dbConfig.drizzleConfigPath,
		migrationsDir: dbConfig.migrationsDir,
		name: dbConfig.name,
		provider: resolveProviderConfig(dbConfig.provider),
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   DEFINE CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

export function defineConfig(input: CombMigrateConfig): MigrationConfig {
	const parsed = configInputSchema.parse(input)

	const databases: Record<string, DatabaseConfig> = {}
	for (const [key, dbInput] of Object.entries(parsed.databases)) {
		/* New format with environments */
		if (dbInput.environments) {
			const environments: Record<string, { name: string; provider?: ProviderConfig | undefined }> = {}
			for (const [envKey, envInput] of Object.entries(dbInput.environments)) {
				environments[envKey] = {
					name: envInput.name,
					provider: envInput.provider,
				}
			}

			databases[key] = {
				drizzleConfigPath: dbInput.drizzleConfigPath,
				environments,
				migrationsDir: dbInput.migrationsDir,
				provider: dbInput.provider,
			}
		} else {
			/* Legacy format */
			if (!dbInput.name || !dbInput.provider) {
				throw new Error(`Database "${key}": legacy format requires both 'name' and 'provider' fields`)
			}

			databases[key] = {
				drizzleConfigPath: dbInput.drizzleConfigPath,
				migrationsDir: dbInput.migrationsDir,
				name: dbInput.name,
				provider: dbInput.provider,
			}
		}
	}

	const multiTenant: MultiTenantConfig | undefined = parsed.multiTenant
		? {
				circuitBreaker: {
					failureThreshold: parsed.multiTenant.circuitBreaker?.failureThreshold ?? 0.1,
					minSampleSize: parsed.multiTenant.circuitBreaker?.minSampleSize ?? 50,
				},
				concurrency: parsed.multiTenant.concurrency,
				enabled: true,
				rootDatabase: parsed.multiTenant.rootDatabase,
				tenantQuery: parsed.multiTenant.tenantQuery,
			}
		: undefined

	return { databases, multiTenant }
}

/* ═══════════════════════════════════════════════════════════════════════════
   LOAD CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

const CONFIG_FILE_NAMES = [
	"db-migration.config.ts",
	"db-migration.config.js",
	"migration.config.ts",
	"migration.config.js",
]

export type LoadedConfig = {
	config: MigrationConfig
	configDir: string
}

export async function loadConfig(configPath?: string): Promise<LoadedConfig> {
	let resolvedPath: string | undefined

	if (configPath) {
		resolvedPath = resolve(process.cwd(), configPath)
		if (!existsSync(resolvedPath)) {
			throw new Error(`Config file not found: ${resolvedPath}`)
		}
	} else {
		for (const name of CONFIG_FILE_NAMES) {
			const candidate = resolve(process.cwd(), name)
			if (existsSync(candidate)) {
				resolvedPath = candidate
				break
			}
		}
	}

	if (!resolvedPath) {
		throw new Error(`No config file found. Create one of: ${CONFIG_FILE_NAMES.join(", ")}`)
	}

	const configDir = resolve(resolvedPath, "..")
	const module = await import(resolvedPath)
	const rawConfig = module.default ?? module

	const config = typeof rawConfig === "function" ? rawConfig() : (rawConfig as MigrationConfig)

	return { config, configDir }
}
