/**
 * Standalone configuration for @lovrozagar/comb migrations.
 * No ProjectConfig dependency — accepts a direct CombMigrateConfig object.
 */
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as z from "zod"
import type { Run } from "./core/process.ts"
import { createD1Provider } from "./drivers/d1.ts"
import { createBunSqliteProvider, createLibsqlProvider, createTursoProvider } from "./drivers/sqlite.ts"
import type {
	ConnectionProvider,
	ConnectionProviderConfig,
	DatabaseConfig,
	MigrationConfig,
	MultiTenantConfig,
	ProviderConfig,
	ResolvedDatabaseConfig,
} from "./types.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIG SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

/** The empty database Atlas replays Postgres migrations on when a provider names none */
export const DEFAULT_PG_DEV_URL = "docker://postgres/17/dev"

const NEON_IS_POSTGRES =
	"Neon and Supabase are postgres URLs: use the postgres provider type with the direct connection URL"

/* Built on use: defineConfig runs once per process, and module scope stays free of work */
const providerInputSchema = () =>
	z.discriminatedUnion("type", [
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
			devUrl: z.string().min(1).optional(),
			lockTimeout: z.string().min(1).optional(),
			schema: z.string().min(1).optional(),
			type: z.literal("postgres"),
			url: z.string().min(1),
		}),
		/* there is no neon type: a Neon or Supabase database is a postgres URL */
		z.object({ type: z.literal("neon") }).transform((_, ctx) => {
			ctx.addIssue({ code: "custom", message: NEON_IS_POSTGRES })
			return z.NEVER
		}),
		z.object({
			databaseId: z.string().min(1),
			databaseName: z.string().min(1),
			local: z.boolean().optional(),
			type: z.literal("d1"),
		}),
	])

const environmentConfigInputSchema = () =>
	z.object({
		name: z.string().min(1),
		provider: providerInputSchema().optional(),
	})

const databaseConfigInputSchema = () =>
	z.object({
		drizzleConfigPath: z.string().optional(),
		environments: z.record(z.string(), environmentConfigInputSchema()).optional(),
		migrationsDir: z.string().min(1),
		name: z.string().min(1).optional(),
		provider: providerInputSchema().optional(),
	})

const multiTenantConfigInputSchema = () =>
	z.object({
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

/** What comb.migrate.config.ts declares: the migration config before multi-tenant defaults fill in */
export type CombMigrateConfig = {
	databases: Record<string, DatabaseConfig>
	multiTenant?:
		| (Omit<MultiTenantConfig, "circuitBreaker"> & {
				circuitBreaker?: MultiTenantConfig["circuitBreaker"] | undefined
		  })
		| undefined
}

/* typed with the declared config, so the schema cannot drift from it */
const configInputSchema = (): z.ZodType<CombMigrateConfig> =>
	z.object({
		databases: z.record(z.string(), databaseConfigInputSchema()),
		multiTenant: multiTenantConfigInputSchema().optional(),
	})

/* ═══════════════════════════════════════════════════════════════════════════
   RESOLVE PROVIDER CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

function resolveProviderConfig(input: ProviderConfig): ResolvedDatabaseConfig["provider"] {
	switch (input.type) {
		case "postgres":
			return {
				devUrl: input.devUrl ?? DEFAULT_PG_DEV_URL,
				lockTimeout: input.lockTimeout ?? "5s",
				schema: input.schema ?? "public",
				type: "postgres",
				url: input.url,
			}
		case "turso":
			return { apiToken: input.apiToken, group: input.group, org: input.org, type: "turso" }
		case "libsql":
			return { authToken: input.authToken, type: "libsql", url: input.url }
		case "bun-sqlite":
			return { path: input.path, type: "bun-sqlite" }
		case "d1":
			return { databaseId: input.databaseId, databaseName: input.databaseName, local: input.local, type: "d1" }
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   CREATE PROVIDER
   ═══════════════════════════════════════════════════════════════════════════ */

/** What a provider that shells out (D1 drives wrangler) runs processes with; tests pass a fake */
export type ProviderDeps = { run?: Run | undefined }

/** The connection for a provider comb applies through itself; Postgres goes through Atlas instead */
export function createProvider(config: ConnectionProviderConfig, deps: ProviderDeps = {}): ConnectionProvider {
	switch (config.type) {
		case "turso":
			return createTursoProvider(config)
		case "libsql":
			return createLibsqlProvider(config)
		case "bun-sqlite":
			return createBunSqliteProvider(config)
		case "d1":
			return createD1Provider(config, deps.run)
		default:
			throw new Error("Atlas applies Postgres migrations; comb opens no connection to postgres")
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   RESOLVE DATABASE CONFIG FOR ENVIRONMENT
   ═══════════════════════════════════════════════════════════════════════════ */

export function resolveDatabaseConfig(dbConfig: DatabaseConfig, envName?: string): ResolvedDatabaseConfig {
	/* New format: environments defined */
	if (dbConfig.environments) {
		if (!envName) {
			const available = Object.keys(dbConfig.environments).join(", ")
			throw new Error(`Database config has environments; pass -e/--env with one of: ${available}`)
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
	const parsed = configInputSchema().parse(input)

	const databases: Record<string, DatabaseConfig> = {}
	for (const [key, dbInput] of Object.entries(parsed.databases)) {
		/* New format with environments */
		if (dbInput.environments) {
			const environments: Record<string, { name: string; provider?: ProviderConfig | undefined }> = {}
			for (const [envKey, envInput] of Object.entries(dbInput.environments)) {
				environments[envKey] = { name: envInput.name, provider: envInput.provider }
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
	"comb.migrate.config.ts",
	"comb.migrate.config.js",
	"db-migration.config.ts",
	"db-migration.config.js",
	"migration.config.ts",
	"migration.config.js",
]

export type LoadedConfig = {
	config: MigrationConfig
	configDir: string
}

/** The migrate config file in `cwd`, by the names comb looks for in order; undefined when there is none */
export function findConfigFile(cwd: string): string | undefined {
	return CONFIG_FILE_NAMES.map((name) => resolve(cwd, name)).find((candidate) => existsSync(candidate))
}

/** Load the migrate config at `configPath`, or the first one `findConfigFile` sees in `cwd` */
export async function loadConfig(configPath?: string, cwd: string = process.cwd()): Promise<LoadedConfig> {
	const resolvedPath = configPath === undefined ? findConfigFile(cwd) : resolve(cwd, configPath)
	if (resolvedPath === undefined) {
		throw new Error(`No config file found. Create one of: ${CONFIG_FILE_NAMES.join(", ")}`)
	}
	if (!existsSync(resolvedPath)) throw new Error(`Config file not found: ${resolvedPath}`)

	const module = (await import(resolvedPath)) as { default?: unknown }
	const rawConfig = module.default ?? module
	const config =
		typeof rawConfig === "function" ? (rawConfig as () => MigrationConfig)() : (rawConfig as MigrationConfig)
	return { config, configDir: dirname(resolvedPath) }
}
