/**
 * The database a `comb migrate` command works on, from comb.migrate.config.ts: its provider, its
 * dialect, and its paths resolved against the config file. `apply` needs an environment when the
 * database declares them; `diff` takes one, and without it reads the database's own provider, or
 * environments that agree on what a diff reads (KC4 of r22b).
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
	/** the comb.config.ts database it maps to: its own name unless it says another (C7) */
	codegen: string
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

type Resolve = (db: DatabaseConfig, env?: string) => ResolvedDatabaseConfig

/** What a diff reads of a provider beside its dialect: Postgres's dev database and schema, or whether SQLite's is D1 */
const diffReads = (provider: ResolvedDatabaseConfig["provider"]): Record<string, unknown> =>
	provider.type === "postgres"
		? { devUrl: provider.devUrl, schema: provider.schema }
		: { "whether it is D1": provider.type === "d1" }

/**
 * What a diff named no environment reads: the database's own provider when it has one, else its
 * environments' when they agree on what a diff reads, never one picked by key order
 */
function diffConfig(name: string, db: DatabaseConfig, resolve: Resolve): ResolvedDatabaseConfig {
	if (db.environments === undefined) return resolve(db)
	const shared = { drizzleConfigPath: db.drizzleConfigPath, migrationsDir: db.migrationsDir, name }
	if (db.provider !== undefined) return resolve({ ...shared, provider: db.provider })
	/* the config's schema refuses a database whose environments name none (K13) */
	const [first, ...others] = Object.keys(db.environments).map((env) => resolve(db, env)) as [
		ResolvedDatabaseConfig,
		...ResolvedDatabaseConfig[],
	]
	const reads = diffReads(first.provider)
	const differ = Object.keys(reads).filter((key) =>
		others.some((other) => diffReads(other.provider)[key] !== reads[key]),
	)
	if (differ.length === 0) return first
	throw new CliError(
		`database "${name}"'s environments differ in ${differ.join(" and ")}, which a diff reads: pass -e/--env with one of: ${Object.keys(db.environments).join(", ")}`,
	)
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
	const resolved =
		request.mode === "diff" && request.env === undefined
			? diffConfig(request.db, db, resolveDatabaseConfig)
			: resolveDatabaseConfig(db, request.env)
	const dialect = dialectOf(resolved.provider.type)
	const codegen = db.codegen ?? request.db
	if (dialect === "postgres") await assertNoFts(request.cwd, codegen)
	return {
		codegen,
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
