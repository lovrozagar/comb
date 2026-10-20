/**
 * The database a `comb migrate` command works on, from comb.migrate.config.ts: its provider, its
 * dialect, and its paths resolved against the config file. `diff` needs no environment (the
 * schema and dialect are the database's, not an environment's); `apply` needs one when the
 * database declares them.
 */
import path from "node:path"
import type { CombMigrateConfig } from "../migrate/config.ts"
import type { DatabaseConfig, Dialect, ResolvedDatabaseConfig } from "../migrate/types.ts"
import { findCombConfig } from "./comb-config.ts"
import { CliError } from "./output.ts"

/** What a command asks for: the database, the environment and directory it names, from where */
type TargetRequest = {
	cwd: string
	db: string
	dir?: string | undefined
	env?: string | undefined
	mode: "apply" | "diff"
}

/** A database resolved for one command */
type MigrateTarget = {
	database: string
	dialect: Dialect
	drizzleConfigPath: string | undefined
	/** how output and prompts name it: the database and its resolved name */
	label: string
	migrationsDir: string
	/** the database's name in its environment, which a provider connects to */
	name: string
	provider: ResolvedDatabaseConfig["provider"]
	/** the folder of comb.migrate.config.ts, where a D1 database's wrangler config is looked for */
	configDir: string
}

const dialectOf = (type: string): Dialect => (type === "postgres" ? "postgres" : "sqlite")

/** The environment a diff reads the provider from: the database's own provider, or its first environment's */
function diffEnvironment(db: DatabaseConfig): string | undefined {
	return db.environments === undefined ? undefined : Object.keys(db.environments)[0]
}

/** A database is one dialect, so every environment's provider must agree */
function assertOneDialect(name: string, db: DatabaseConfig): void {
	const types = [db.provider, ...Object.values(db.environments ?? {}).map((env) => env.provider)]
	const dialects = new Set(types.flatMap((provider) => (provider === undefined ? [] : [dialectOf(provider.type)])))
	if (dialects.size > 1) {
		throw new CliError(`database "${name}" mixes sqlite and postgres environments; one database has one dialect`)
	}
}

/** comb.config.ts's FTS5 tables are SQLite virtual tables; a Postgres database has no such thing */
async function assertNoFts(cwd: string, name: string): Promise<void> {
	const fts = (await findCombConfig(cwd))?.databases[name]?.fts
	if (fts !== undefined && Object.keys(fts).length > 0) {
		throw new CliError(
			`comb.config.ts gives the Postgres database "${name}" FTS5 tables, which are SQLite; use a tsvector column with a GIN index`,
		)
	}
}

function databaseIn(config: CombMigrateConfig, configFile: string, name: string): DatabaseConfig {
	if (Object.hasOwn(config.databases, name)) return config.databases[name] as DatabaseConfig
	const available = Object.keys(config.databases).join(", ")
	throw new CliError(`${path.basename(configFile)} declares no database "${name}". Available: ${available}`)
}

/** The database `request.db` names in the project's comb.migrate.config.ts; undefined when the project has none */
async function resolveMigrateTarget(request: TargetRequest): Promise<MigrateTarget | undefined> {
	const { findConfigFile, loadConfig, resolveDatabaseConfig } = await import("../migrate/config.ts")
	const configFile = findConfigFile(request.cwd)
	if (configFile === undefined) return undefined
	const { config, configDir } = await loadConfig(configFile, request.cwd)
	const db = databaseIn(config, configFile, request.db)
	assertOneDialect(request.db, db)
	const env = request.env ?? (request.mode === "diff" ? diffEnvironment(db) : undefined)
	const resolved = resolveDatabaseConfig(db, env)
	const dialect = dialectOf(resolved.provider.type)
	if (dialect === "postgres") await assertNoFts(request.cwd, request.db)
	return {
		database: request.db,
		dialect,
		drizzleConfigPath:
			resolved.drizzleConfigPath === undefined ? undefined : path.resolve(configDir, resolved.drizzleConfigPath),
		label: `${request.db} (${resolved.name})`,
		migrationsDir: path.resolve(configDir, request.dir ?? resolved.migrationsDir),
		name: resolved.name,
		provider:
			resolved.provider.type === "d1" && resolved.provider.wranglerConfig !== undefined
				? { ...resolved.provider, wranglerConfig: path.resolve(configDir, resolved.provider.wranglerConfig) }
				: resolved.provider,
		configDir,
	}
}

export { type MigrateTarget, resolveMigrateTarget, type TargetRequest }
