/**
 * Standalone configuration for @lovrozagar/comb migrations.
 * No ProjectConfig dependency — accepts a direct CombMigrateConfig object.
 */
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as z from "zod"
import { type CombMigrateConfig, configInputSchema, DEFAULT_PG_DEV_URL } from "./config-schema.ts"
import type { Run } from "./core/process.ts"
import { createD1Provider } from "./drivers/d1.ts"
import { createBunSqliteProvider, createLibsqlProvider, createTursoProvider } from "./drivers/sqlite.ts"
import type {
	ConnectionProvider,
	ConnectionProviderConfig,
	DatabaseConfig,
	MigrationConfig,
	ProviderConfig,
	ResolvedDatabaseConfig,
} from "./types.ts"

export { type CombMigrateConfig, DEFAULT_PG_DEV_URL }

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
		/* every other provider resolves to itself */
		case "turso":
		case "libsql":
		case "bun-sqlite":
		case "d1":
			return { ...input }
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

		/* own keys only: `constructor` or `__proto__` names no environment */
		const envConfig = Object.hasOwn(dbConfig.environments, envName) ? dbConfig.environments[envName] : undefined
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
			name: envConfig.name ?? envName,
			provider: resolveProviderConfig(provider),
		}
	}

	/* Legacy format: no environments, single name */
	if (envName !== undefined)
		throw new Error(`the database declares no environments, so -e ${envName} names none; drop -e`)
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

/** `input`, typed: comb.migrate.config.ts's default export; loadConfig validates it, in one place (P11, K12 of the 0.15.0 review) */
export function defineConfig(input: CombMigrateConfig): CombMigrateConfig {
	return input
}

/** `input` held to the config schema: a typo, or a database of neither shape, throws a ZodError naming where */
export function parseConfig(input: unknown): MigrationConfig {
	return configInputSchema().parse(input)
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

	try {
		const module = (await import(resolvedPath)) as { default?: unknown }
		const rawConfig = module.default ?? module
		/* a function may return the config or a promise of it */
		const exported: unknown = typeof rawConfig === "function" ? await (rawConfig as () => unknown)() : rawConfig
		return { config: parseConfig(exported), configDir: dirname(resolvedPath) }
	} catch (error) {
		if (!(error instanceof z.ZodError)) throw error
		throw new Error(`${resolvedPath} is not a valid migrate config:\n${z.prettifyError(error)}`, { cause: error })
	}
}
