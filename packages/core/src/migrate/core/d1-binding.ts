/**
 * A D1 binding as comb reaches it through wrangler: the wrangler config wrangler would read, the
 * binding it names there, checked to read the migrations comb reads, and where wrangler 4 keeps
 * its local database, which check and status must find before they read it (d1-history.ts).
 */
import { createHash, createHmac } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Connection } from "../types.ts"
import type { Run } from "./process.ts"
import { D1_MIGRATIONS_TABLE } from "./d1-history-tables.ts"

/** A D1 binding as wrangler's config reader returns it, for the environment asked */
type WranglerD1 = {
	binding: string
	database_id?: string | undefined
	database_name?: string | undefined
	migrations_dir?: string | undefined
	migrations_pattern?: string | undefined
	migrations_table?: string | undefined
	preview_database_id?: string | undefined
}

/** What comb reads of wrangler's resolved config */
type WranglerConfig = { d1_databases: readonly WranglerD1[] }

/** wrangler's `unstable_readConfig`; tests pass a fake */
type ReadConfig = (args: { config: string; env?: string | undefined }) => WranglerConfig

/** The D1 database a command works on, as wrangler names and reaches it */
type D1Target = {
	/** the database's wrangler commands: the d1 execute connection, flags included */
	conn: Connection
	exec: Run
	/** --local or --remote, then --config and --env */
	flags: readonly string[]
	migrationsDir: string
	/** the binding's name or database_name, as every wrangler command takes it */
	name: string
	/** the wrangler config file */
	wranglerConfig: string
	wranglerEnv?: string | undefined
}

const CONFIG_NAMES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]

/** The wrangler config wrangler itself would read in `cwd`; undefined when there is none */
function findWranglerConfig(cwd: string): string | undefined {
	return CONFIG_NAMES.map((name) => join(cwd, name)).find((file) => existsSync(file))
}

/**
 * The binding `target` names in its wrangler config, checked: it must exist in the environment,
 * read the migrations comb reads, and take every .sql file there. Returns its migrations table.
 */
function resolveBinding(read: ReadConfig, target: D1Target): string {
	const { d1, where } = bindingOf(read, target)
	const dirName = d1.migrations_dir ?? "migrations"
	const dir = resolve(dirname(target.wranglerConfig), dirName)
	if (dir !== resolve(target.migrationsDir)) {
		throw new Error(
			`${where} applies ${target.name}'s migrations from ${dir}, but comb reads them from ${resolve(target.migrationsDir)}; point migrations_dir at comb's migrationsDir`,
		)
	}
	const pattern = d1.migrations_pattern
	if (pattern !== undefined && pattern.replace(/^\.\//, "") !== `${dirName.replace(/^\.\/|\/$/g, "")}/*.sql`) {
		throw new Error(`${where} sets migrations_pattern ${pattern}; comb applies every .sql file of ${dirName}`)
	}
	return d1.migrations_table ?? D1_MIGRATIONS_TABLE
}

/** The binding `target` names in its wrangler config, and where comb says it read it */
function bindingOf(read: ReadConfig, target: D1Target): { d1: WranglerD1; where: string } {
	const config = read({ config: target.wranglerConfig, env: target.wranglerEnv })
	const where = `${target.wranglerConfig}${target.wranglerEnv === undefined ? "" : ` (env ${target.wranglerEnv})`}`
	const d1 = config.d1_databases.find((db) => db.database_name === target.name || db.binding === target.name)
	if (d1 === undefined) throw new Error(`${where} has no D1 database named or bound as ${target.name}`)
	return { d1, where }
}

/* the Durable Object class Miniflare keeps each local D1 database in */
const D1_OBJECT = "miniflare-D1DatabaseObject"

/**
 * Where wrangler 4 keeps a binding's local database: Miniflare's D1 object under the config's
 * `.wrangler/state/v3/d1`, its file named by the object's id for the binding's preview id, else its
 * id, else the binding itself, as Miniflare's idFromName derives it. This copies Miniflare's own
 * naming, so a test holds it to the wrangler comb pins.
 */
function localD1Path(configDir: string, d1: WranglerD1): string {
	const name = d1.preview_database_id ?? d1.database_id ?? d1.binding
	const key = createHash("sha256").update(D1_OBJECT).digest()
	const named = createHmac("sha256", key).update(name).digest().subarray(0, 16)
	const id = Buffer.concat([named, createHmac("sha256", key).update(named).digest().subarray(0, 16)]).toString("hex")
	return join(configDir, ".wrangler", "state", "v3", "d1", D1_OBJECT, `${id}.sqlite`)
}

/** Whether `target` is a local database wrangler keeps nowhere yet: its first `d1 execute --local` would create one */
function localMissing(read: ReadConfig, target: D1Target): boolean {
	return (
		target.flags.includes("--local") &&
		!existsSync(localD1Path(dirname(target.wranglerConfig), bindingOf(read, target).d1))
	)
}

/**
 * Refuses a read-only command on a local database wrangler keeps nowhere comb can find: its first
 * `d1 execute --local` would create one
 */
function assertLocalExists(read: ReadConfig, target: D1Target): void {
	if (!localMissing(read, target)) return
	const path = localD1Path(dirname(target.wranglerConfig), bindingOf(read, target).d1)
	throw new Error(
		`comb cannot confirm ${target.name}'s local database exists: wrangler 4 keeps it at ${path}, and there is none; check and status open a database read-only, and create none`,
	)
}

export {
	assertLocalExists,
	type D1Target,
	findWranglerConfig,
	localD1Path,
	localMissing,
	type ReadConfig,
	resolveBinding,
	type WranglerConfig,
	type WranglerD1,
}
