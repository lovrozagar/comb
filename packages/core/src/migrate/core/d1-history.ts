/**
 * D1 migrations through wrangler. `wrangler d1 migrations apply` runs each file with its row in
 * the binding's `migrations_table` (`d1_migrations` by default) as one batch, so that table is the
 * history and wrangler the applier. comb resolves the binding from the wrangler config the way
 * wrangler does, reads the table, checks the pending files (plan-apply.ts) in wrangler's order,
 * hands them to wrangler with stdin closed, and fails unless the table then holds exactly the
 * files it checked. wrangler takes no backup; bookmark a production database before an apply.
 * That table records names only, so comb records each applied file's hash in its own table, and
 * refuses a file applied, then edited, as it does on its other engines.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Connection, ParsedMigration } from "../types.ts"
import type { Approval } from "./approval.ts"
import { executeAll } from "../drivers/d1.ts"
import { assertLocalExists, type D1Target, type ReadConfig, resolveBinding } from "./d1-binding.ts"
import { orphanMessage } from "./history-match.ts"
import { generateMigrationHash, legacyMigrationHash, migrationHashes } from "./parse.ts"
import { planApply, wranglerOrder } from "./plan-apply.ts"

const DRIZZLE_TABLE = "__drizzle_migrations"
/* comb's own record of the hash each file was applied under: wrangler's table holds names only */
const HASH_TABLE = "_comb_migration_hashes"
const quoteName = (name: string): string => `"${name.replaceAll('"', '""')}"`
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`

/** wrangler's own migrations table, made as wrangler makes it */
const historyTable = (table: string): string =>
	`CREATE TABLE IF NOT EXISTS ${quoteName(table)} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`

/** The names the migrations table `table` records, in order */
const namesOf = (table: string): string => `SELECT name FROM ${quoteName(table)} ORDER BY id`

/** One statement's rows, as executeAll answers them */
type Rows = Array<Record<string, unknown>>

/** What the history tables hold: wrangler's names, comb's hashes, and comb's pre-0.8 record, undefined where it is absent */
type HistoryRead = { applied: Set<string>; drizzle: Set<string> | undefined; recorded: Map<string, string> }

/**
 * The history in as few wrangler calls as it takes, each a process of its own (R1). With `create`
 * (apply and baseline) the tables are made as wrangler makes them and read in that one call;
 * without (status and check, which never write) a listing says which exist, and one more call
 * reads those, as does a pre-0.8 record that exists.
 */
function readHistory(target: D1Target, table: string, create: boolean): HistoryRead {
	const [names, hashes, drizzle] = [
		namesOf(table),
		`SELECT name, hash FROM ${HASH_TABLE}`,
		`SELECT hash FROM ${DRIZZLE_TABLE}`,
	]
	const listing = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${[table, HASH_TABLE, DRIZZLE_TABLE].map(literal).join(", ")})`
	const made = [
		historyTable(table),
		`CREATE TABLE IF NOT EXISTS ${HASH_TABLE} (name TEXT PRIMARY KEY, hash TEXT NOT NULL)`,
	]
	const first = executeAll(target.exec, target, create ? [...made, listing, names, hashes] : [listing])
	/* executeAll answers one result per statement, or throws */
	const present = new Set((first[create ? 2 : 0] as Rows).map((row) => String(row["name"])))
	const rows = new Map(
		create
			? [
					[names, first[3]],
					[hashes, first[4]],
				]
			: [],
	)
	const later = [names, hashes, drizzle].filter(
		(sql, i) => !rows.has(sql) && present.has([table, HASH_TABLE, DRIZZLE_TABLE][i] as string),
	)
	if (later.length > 0) executeAll(target.exec, target, later).forEach((each, i) => rows.set(later[i] as string, each))
	const read = (sql: string) => rows.get(sql) ?? []
	return {
		applied: new Set(read(names).map((row) => String(row["name"]))),
		drizzle: present.has(DRIZZLE_TABLE) ? new Set(read(drizzle).map((row) => String(row["hash"]))) : undefined,
		recorded: new Map(read(hashes).map((row) => [String(row["name"]), String(row["hash"])])),
	}
}

/** Record the hash each of `files` was applied under; both callers pass at least one */
async function recordHashes(conn: Connection, files: ReadonlyArray<{ hash: string; name: string }>): Promise<void> {
	await conn.batch(
		files.map(({ hash, name }) => ({
			sql: `INSERT OR REPLACE INTO ${HASH_TABLE} (name, hash) VALUES (${literal(name)}, ${literal(hash)})`,
		})),
	)
}

/**
 * Whether `hash`, recorded for a file of text `sql`, is that text: its current hash, or its
 * pre-0.5.0 one where comb's pre-0.8 history (`drizzle`) still holds it, proof the record is from
 * before 0.5.0, as a 0.13 baseline copied it (M44)
 */
const vouched = (sql: string, hash: string, drizzle: ReadonlySet<string> | undefined): boolean =>
	hash === generateMigrationHash(sql) || (hash === legacyMigrationHash(sql) && drizzle?.has(hash) === true)

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
 * it does not, or while it records a name no file has (an applied file renamed or deleted since),
 * which only status lets by, to name; `create` makes a missing table, as only apply may
 */
async function history(
	read: ReadConfig,
	target: D1Target,
	{ create, status = false }: { create: boolean; status?: boolean },
): Promise<{ applied: Set<string>; orphans: string; table: string; unhashed: string[] }> {
	const table = resolveBinding(read, target)
	if (!create) assertLocalExists(read, target)
	const { applied, drizzle: hashes, recorded } = readHistory(target, table, create)
	const files = filesOf(target.migrationsDir)
	const copied = hashes === undefined ? [] : recordedByDrizzle(files, hashes, applied)
	if (copied.length > 0) {
		throw new Error(
			`${target.name} records ${copied.join(", ")} in ${DRIZZLE_TABLE}, comb's history before 0.8, but not in ${table}, wrangler's; run comb migrate baseline once to copy the record`,
		)
	}
	const edited = files.find(
		({ name, sql }) => applied.has(name) && recorded.has(name) && !vouched(sql, recorded.get(name) as string, hashes),
	)
	if (edited !== undefined) {
		throw new Error(
			`${edited.name} was applied, then edited: its hash is not the one comb recorded; restore the file, or put the change in a new one`,
		)
	}
	const unhashed = files.filter(({ name }) => applied.has(name) && !recorded.has(name)).map(({ name }) => name)
	const named = new Set(files.map(({ name }) => name))
	const gone = [...applied].filter((name) => !named.has(name))
	const orphans =
		gone.length === 0
			? ""
			: orphanMessage(
					gone.map((name) => ({ hash: "", name })),
					target.migrationsDir,
				)
	if (orphans !== "" && !status) throw new Error(orphans)
	return { applied, orphans, table, unhashed }
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
	const { applied, table } = await history(options.read, target, { create: options.checkOnly !== true })
	const files = filesOf(target.migrationsDir).map(({ name }) => name)
	const pending = await planApply({
		applied: (name) => applied.has(name),
		approve: options.approve,
		conn: target.conn,
		dir: target.migrationsDir,
		exec: target.exec,
		files,
		/* the binding's own history table, and comb's record of hashes, which apply may have made already */
		historyTables: [table, HASH_TABLE],
		print: options.print,
	})
	const names = pending.map(({ name }) => name)
	if (names.length === 0 || options.checkOnly === true) return names
	for (const name of names) options.print(`Apply: ${name}`)
	const ran = target.exec("wrangler", ["d1", "migrations", "apply", target.name, ...target.flags], { input: "" })
	/* what wrangler recorded, read back from the table, never from its output */
	const after = new Set(
		(executeAll(target.exec, target, [namesOf(table)])[0] as Rows).map((row) => String(row["name"])),
	)
	if (ran.code !== 0) {
		/* the files wrangler applied before it failed are applied: their hashes are recorded as any other's */
		const done = pending.filter(({ name }) => after.has(name))
		if (done.length > 0)
			await recordHashes(
				target.conn,
				done.map(({ migration, name }) => ({ hash: migration.hash, name })),
			)
		throw new Error(`wrangler d1 migrations apply failed: ${`${ran.stderr}${ran.stdout}`.trim()}`)
	}
	const added = [...after].filter((name) => !applied.has(name))
	if (added.length !== names.length || names.some((name) => !after.has(name))) {
		throw new Error(
			`wrangler recorded ${added.join(", ") || "nothing"} in ${table}, where comb checked ${names.join(", ")}; see the wrangler output above`,
		)
	}
	await recordHashes(
		target.conn,
		pending.map(({ migration, name }) => ({ hash: migration.hash, name })),
	)
	return names
}

/**
 * Copy comb's history before 0.8 into wrangler's: the name of each file whose hash
 * `__drizzle_migrations` records, in wrangler's order. Any other file is left for apply to run.
 * Returns the names recorded.
 */
async function baselineD1(target: D1Target, read: ReadConfig, print: (line: string) => void): Promise<string[]> {
	const table = resolveBinding(read, target)
	const { applied, drizzle: hashes } = readHistory(target, table, true)
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
		/* each copied file is vouched for now, so it is recorded under its current hash, the one D1 compares (M44) */
		await recordHashes(
			target.conn,
			files
				.filter(({ name }) => copied.includes(name))
				.map(({ name, sql }) => ({ hash: generateMigrationHash(sql), name })),
		)
	}
	for (const name of copied) print(`Marked applied: ${name}`)
	for (const { name } of files.filter((file) => !applied.has(file.name) && !copied.includes(file.name))) {
		print(`Not marked: ${name} (${DRIZZLE_TABLE} has no record of it; comb migrate apply runs it)`)
	}
	return copied
}

/**
 * Record the current hash of each applied file comb has none for, as applied before comb recorded
 * hashes (M1), and print each; returns them. The operator vouches that the files are what was
 * applied, having checked them against git; the history's own checks run first, so a pre-0.8
 * record to copy, an applied file edited since, or a name no file has refuses it.
 */
async function adoptHashesD1(target: D1Target, read: ReadConfig, print: (line: string) => void): Promise<string[]> {
	const { unhashed } = await history(read, target, { create: true })
	const files = filesOf(target.migrationsDir).filter(({ name }) => unhashed.includes(name))
	if (files.length > 0)
		await recordHashes(
			target.conn,
			files.map(({ name, sql }) => ({ hash: generateMigrationHash(sql), name })),
		)
	for (const { name } of files) print(`Hash recorded: ${name}`)
	return unhashed
}

/** Print what wrangler's table records as applied, and what is pending, in wrangler's order; returns both */
async function statusD1(
	target: D1Target,
	read: ReadConfig,
	print: (line: string) => void,
): Promise<{ applied: string[]; pending: string[] }> {
	const { applied: recorded, orphans, unhashed } = await history(read, target, { create: false, status: true })
	if (orphans !== "") print(orphans)
	const files = filesOf(target.migrationsDir).map(({ name }) => name)
	const applied = files.filter((name) => recorded.has(name))
	const pending = files.filter((name) => !recorded.has(name))
	print(`Applied: ${applied.join(", ") || "none"}`)
	print(`Pending: ${pending.join(", ") || "none"}`)
	if (unhashed.length > 0)
		print(
			`No hash recorded for ${unhashed.join(", ")}, applied before comb recorded them: comb cannot tell whether ${unhashed.length === 1 ? "it was" : "they were"} edited since`,
		)
	return { applied, pending }
}

export { adoptHashesD1, applyD1, baselineD1, statusD1 }
