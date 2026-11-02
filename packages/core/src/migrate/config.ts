/**
 * Standalone configuration for @lovrozagar/comb migrations.
 * No ProjectConfig dependency — accepts a direct CombMigrateConfig object.
 */
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
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

/**
 * `input`, typed: comb.migrate.config.ts's default export, an object or a function, sync or async,
 * that returns one (K9 of r20); loadConfig validates it, in one place (P11, K12 of the 0.15.0 review).
 * The function form comes first: TypeScript types an arrow's body once, against the first overload it
 * tries, so an object overload ahead of it widens an inline `type: "d1"` to string. A generic object
 * form would skip the excess-property check on an object written inline. NoInfer keeps an annotated
 * target, `() => Promise<CombMigrateConfig>`, from inferring R ahead of the arrow's own body
 */
export function defineConfig<R extends CombMigrateConfig | Promise<CombMigrateConfig>>(input: () => R): () => NoInfer<R>
export function defineConfig(input: CombMigrateConfig): CombMigrateConfig
export function defineConfig(
	input: CombMigrateConfig | (() => CombMigrateConfig | Promise<CombMigrateConfig>),
): CombMigrateConfig | (() => CombMigrateConfig | Promise<CombMigrateConfig>) {
	return input
}

/**
 * What a config module exports, held to the config schema: an object, or a function that returns one
 * or a promise of one (K8 of r19). A typo, or a database of neither shape, rejects with a ZodError
 * naming where
 */
export async function parseConfig(input: unknown): Promise<MigrationConfig> {
	const exported: unknown = typeof input === "function" ? await (input as () => unknown)() : input
	return configInputSchema().parse(exported)
}

/* ═══════════════════════════════════════════════════════════════════════════
   LOAD CONFIG
   ═══════════════════════════════════════════════════════════════════════════ */

const CONFIG_FILE_NAMES = ["comb.migrate.config.ts", "comb.migrate.config.js"]

/* names comb read before 0.19, which other migration tools use too: refused, never run (K6 of r20) */
const RETIRED_FILE_NAMES = [
	"db-migration.config.ts",
	"db-migration.config.js",
	"migration.config.ts",
	"migration.config.js",
]

export type LoadedConfig = {
	config: MigrationConfig
	configDir: string
}

/**
 * The migrate config file in `cwd`, by the names comb looks for in order; undefined when there is
 * none. A file by a name comb read before 0.19, with no comb config beside it, is refused unrun:
 * without a config comb reads the database name as a D1 binding, so ignoring it could migrate
 * another database.
 */
export function findConfigFile(cwd: string): string | undefined {
	const found = CONFIG_FILE_NAMES.map((name) => resolve(cwd, name)).find((candidate) => existsSync(candidate))
	if (found !== undefined) return found
	const retired = RETIRED_FILE_NAMES.find((name) => existsSync(resolve(cwd, name)))
	if (retired !== undefined)
		throw new Error(
			`comb no longer reads ${retired}, and did not run it: rename it to comb.migrate.config.ts if it is comb's migrate config, or add a comb.migrate.config.ts beside it if it is another tool's`,
		)
	return undefined
}

/** Load the migrate config at `configPath`, or the first one `findConfigFile` sees in `cwd` */
export async function loadConfig(configPath?: string, cwd: string = process.cwd()): Promise<LoadedConfig> {
	const resolvedPath = configPath === undefined ? findConfigFile(cwd) : resolve(cwd, configPath)
	if (resolvedPath === undefined) {
		throw new Error("No config file found. Create comb.migrate.config.ts (or comb.migrate.config.js)")
	}
	if (!existsSync(resolvedPath)) throw new Error(`Config file not found: ${resolvedPath}`)

	try {
		const module = (await import(pathToFileURL(resolvedPath).href)) as { default?: unknown }
		return { config: await parseConfig(module.default ?? module), configDir: dirname(resolvedPath) }
	} catch (error) {
		if (!(error instanceof z.ZodError)) throw error
		throw new Error(`${resolvedPath} is not a valid migrate config:\n${z.prettifyError(error)}`, { cause: error })
	}
}
