/**
 * D1 migrations through wrangler. `wrangler d1 migrations apply` runs each file with its row in
 * the binding's `migrations_table` (`d1_migrations` by default) as one batch, so that table is the
 * history and wrangler the applier. comb resolves the binding from the wrangler config the way
 * wrangler does, reads the table, checks the pending files (plan-apply.ts) in wrangler's order,
 * hands them to wrangler with stdin closed, and fails unless the table then holds exactly the
 * files it checked. wrangler takes no backup; bookmark a production database before an apply.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Connection, ParsedMigration } from "../types.ts"
import type { Approval } from "./approval.ts"
import { migrationHashes } from "./parse.ts"
import { planApply, wranglerOrder } from "./plan-apply.ts"
import type { Run } from "./process.ts"

/** A D1 binding as wrangler's config reader returns it, for the environment asked */
type WranglerD1 = {
	binding: string
	database_name?: string | undefined
	migrations_dir?: string | undefined
	migrations_pattern?: string | undefined
	migrations_table?: string | undefined
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

const DRIZZLE_TABLE = "__drizzle_migrations"
const CONFIG_NAMES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]

const quoteName = (name: string): string => `"${name.replaceAll('"', '""')}"`
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`

/** The wrangler config wrangler itself would read in `cwd`; undefined when there is none */
function findWranglerConfig(cwd: string): string | undefined {
	return CONFIG_NAMES.map((name) => join(cwd, name)).find((file) => existsSync(file))
}

/**
 * The binding `target` names in its wrangler config, checked: it must exist in the environment,
 * read the migrations comb reads, and take every .sql file there. Returns its migrations table.
 */
function resolveBinding(read: ReadConfig, target: D1Target): string {
	const config = read({ config: target.wranglerConfig, env: target.wranglerEnv })
	const where = `${target.wranglerConfig}${target.wranglerEnv === undefined ? "" : ` (env ${target.wranglerEnv})`}`
	const d1 = config.d1_databases.find((db) => db.database_name === target.name || db.binding === target.name)
	if (d1 === undefined) throw new Error(`${where} has no D1 database named or bound as ${target.name}`)
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
	return d1.migrations_table ?? "d1_migrations"
}

/** The rows of one column of `sql` */
async function column(conn: Connection, sql: string): Promise<string[]> {
	return (await conn.execute(sql)).rows.map((row) => String(row[0]))
}

/**
 * The names the migrations table records. With `create` (apply and baseline) the table is made
 * as wrangler makes it when missing; without (status and check, which never write), a missing
 * table records nothing.
 */
async function appliedNames(conn: Connection, table: string, create: boolean): Promise<Set<string>> {
	if (create) {
		await conn.execute(
			`CREATE TABLE IF NOT EXISTS ${quoteName(table)} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`,
		)
	} else if (
		(await column(conn, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${literal(table)}`)).length ===
		0
	) {
		return new Set()
	}
	return new Set(await column(conn, `SELECT name FROM ${quoteName(table)} ORDER BY id`))
}

/** The hashes comb before 0.8 recorded in `__drizzle_migrations`; undefined when the table is absent */
async function drizzleHashes(conn: Connection): Promise<Set<string> | undefined> {
	const found = await column(conn, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${DRIZZLE_TABLE}'`)
	return found.length === 0 ? undefined : new Set(await column(conn, `SELECT hash FROM ${DRIZZLE_TABLE}`))
}

/** The migration files of the directory in wrangler's order, with their text */
function filesOf(dir: string): Array<{ name: string; sql: string }> {
	const names = wranglerOrder(readdirSync(dir).filter((name) => name.endsWith(".sql")))
	return names.map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }))
}

/** The files `__drizzle_migrations` records that the migrations table does not */
function recordedByDrizzle(
	files: ReturnType<typeof filesOf>,
	hashes: ReadonlySet<string>,
	applied: ReadonlySet<string>,
): string[] {
	return files
		.filter(({ name, sql }) => !applied.has(name) && migrationHashes(sql).some((hash) => hashes.has(hash)))
		.map(({ name }) => name)
}

/**
 * The history: the migrations table's names, refused while `__drizzle_migrations` records a file
 * it does not; `create` makes a missing table, as only apply may
 */
async function history(
	read: ReadConfig,
	target: D1Target,
	create: boolean,
): Promise<{ applied: Set<string>; table: string }> {
	const table = resolveBinding(read, target)
	const applied = await appliedNames(target.conn, table, create)
	const hashes = await drizzleHashes(target.conn)
	const copied = hashes === undefined ? [] : recordedByDrizzle(filesOf(target.migrationsDir), hashes, applied)
	if (copied.length > 0) {
		throw new Error(
			`${target.name} records ${copied.join(", ")} in ${DRIZZLE_TABLE}, comb's history before 0.8, but not in ${table}, wrangler's; run comb migrate baseline once to copy the record`,
		)
	}
	return { applied, table }
}

type D1Apply = {
	approve(migration: ParsedMigration): Promise<Approval>
	/** only check: apply nothing */
	checkOnly?: boolean | undefined
	print(line: string): void
	read: ReadConfig
}

/** Check the pending migrations and, unless only checking, apply them through wrangler; returns them */
async function applyD1(target: D1Target, options: D1Apply): Promise<string[]> {
	const { applied, table } = await history(options.read, target, options.checkOnly !== true)
	const files = filesOf(target.migrationsDir).map(({ name }) => name)
	const pending = await planApply({
		applied: (name) => applied.has(name),
		approve: options.approve,
		conn: target.conn,
		dir: target.migrationsDir,
		exec: target.exec,
		files,
		/* the binding's own history table, which apply may have made already */
		historyTables: [table],
		print: options.print,
	})
	const names = pending.map(({ name }) => name)
	if (names.length === 0 || options.checkOnly === true) return names
	for (const name of names) options.print(`Apply: ${name}`)
	const ran = target.exec("wrangler", ["d1", "migrations", "apply", target.name, ...target.flags], { input: "" })
	if (ran.code !== 0) throw new Error(`wrangler d1 migrations apply failed: ${`${ran.stderr}${ran.stdout}`.trim()}`)
	const after = await appliedNames(target.conn, table, true)
	const added = [...after].filter((name) => !applied.has(name))
	if (added.length !== names.length || names.some((name) => !after.has(name))) {
		throw new Error(
			`wrangler recorded ${added.join(", ") || "nothing"} in ${table}, where comb checked ${names.join(", ")}; see the wrangler output above`,
		)
	}
	return names
}

/**
 * Copy comb's history before 0.8 into wrangler's: the name of each file whose hash
 * `__drizzle_migrations` records, in wrangler's order. Any other file is left for apply to run.
 * Returns the names recorded.
 */
async function baselineD1(target: D1Target, read: ReadConfig, print: (line: string) => void): Promise<string[]> {
	const table = resolveBinding(read, target)
	const applied = await appliedNames(target.conn, table, true)
	const hashes = await drizzleHashes(target.conn)
	if (hashes === undefined) {
		throw new Error(
			`${target.name} has no ${DRIZZLE_TABLE} to copy from; baseline records only what a history shows was applied`,
		)
	}
	const files = filesOf(target.migrationsDir)
	const copied = recordedByDrizzle(files, hashes, applied)
	if (copied.length > 0) {
		await target.conn.batch(
			copied.map((name) => ({ sql: `INSERT OR IGNORE INTO ${quoteName(table)} (name) VALUES (${literal(name)})` })),
		)
	}
	for (const name of copied) print(`Marked applied: ${name}`)
	for (const { name } of files.filter((file) => !applied.has(file.name) && !copied.includes(file.name))) {
		print(`Not marked: ${name} (${DRIZZLE_TABLE} has no record of it; comb migrate apply runs it)`)
	}
	return copied
}

/** Print what wrangler's table records as applied, and what is pending, in wrangler's order; returns both */
async function statusD1(
	target: D1Target,
	read: ReadConfig,
	print: (line: string) => void,
): Promise<{ applied: string[]; pending: string[] }> {
	const recorded = (await history(read, target, false)).applied
	const files = filesOf(target.migrationsDir).map(({ name }) => name)
	const applied = files.filter((name) => recorded.has(name))
	const pending = files.filter((name) => !recorded.has(name))
	print(`Applied: ${applied.join(", ") || "none"}`)
	print(`Pending: ${pending.join(", ") || "none"}`)
	return { applied, pending }
}

export { applyD1, baselineD1, type D1Target, findWranglerConfig, type ReadConfig, statusD1, type WranglerConfig }
