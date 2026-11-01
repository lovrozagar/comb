/**
 * The rows of a D1 database's history, as comb reads and writes them through wrangler: wrangler's
 * migrations table, comb's hash table and comb's pre-0.8 `__drizzle_migrations`, and the statements
 * that write them in the order the history's invariant needs.
 */
import type { Connection } from "../types.ts"
import { executeAll } from "../drivers/d1.ts"
import { type D1Target, localMissing, type ReadConfig } from "./d1-binding.ts"
import { D1_HASH_TABLE, DRIZZLE_HISTORY_TABLE } from "./d1-history-tables.ts"

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

/** What a database comb never reached holds: no history at all */
const noHistory = (): HistoryRead => ({ applied: new Set(), drizzle: undefined, recorded: new Map() })

/**
 * The history in as few wrangler calls as it takes, each a process of its own (R1): a listing says
 * which tables exist, and one more call reads those. Nothing is made: apply and baseline write their
 * tables only once every check has passed (S5 of the 0.15.0 review), and a local database wrangler
 * keeps nowhere yet holds no history, read without a call that would create it.
 */
function readHistory(read: ReadConfig, target: D1Target, table: string): HistoryRead {
	if (localMissing(read, target)) return noHistory()
	const [names, hashes, drizzle] = [
		namesOf(table),
		`SELECT name, hash FROM ${D1_HASH_TABLE}`,
		`SELECT hash FROM ${DRIZZLE_HISTORY_TABLE}`,
	]
	const tables = [table, D1_HASH_TABLE, DRIZZLE_HISTORY_TABLE]
	const listing = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(literal).join(", ")})`
	/* executeAll answers one result per statement, or throws */
	const present = new Set((executeAll(target.exec, target, [listing])[0] as Rows).map((row) => String(row["name"])))
	const later = [names, hashes, drizzle].filter((_, i) => present.has(tables[i] as string))
	const rows = new Map<string, Rows>()
	if (later.length > 0) executeAll(target.exec, target, later).forEach((each, i) => rows.set(later[i] as string, each))
	const at = (sql: string) => rows.get(sql) ?? []
	return {
		applied: new Set(at(names).map((row) => String(row["name"]))),
		drizzle: present.has(DRIZZLE_HISTORY_TABLE) ? new Set(at(drizzle).map((row) => String(row["hash"]))) : undefined,
		recorded: new Map(at(hashes).map((row) => [String(row["name"]), String(row["hash"])])),
	}
}

/**
 * The statements that record the hash each of `files` was applied under, comb's table made first.
 * The invariant every writer keeps (S2, S3 of r19): a name is in wrangler's table only once its hash
 * is in comb's. So these run before anything that names a file, and a hash row whose name wrangler's
 * table lacks is inert: history() reads the hashes of applied names only, and a rerun replaces it
 */
const hashStatements = (files: ReadonlyArray<{ hash: string; name: string }>): Array<{ sql: string }> => [
	{ sql: `CREATE TABLE IF NOT EXISTS ${D1_HASH_TABLE} (name TEXT PRIMARY KEY, hash TEXT NOT NULL)` },
	...files.map(({ hash, name }) => ({
		sql: `INSERT OR REPLACE INTO ${D1_HASH_TABLE} (name, hash) VALUES (${literal(name)}, ${literal(hash)})`,
	})),
]

/** Record the hash each of `files` was applied under, in one batch; both callers pass at least one */
async function recordHashes(conn: Connection, files: ReadonlyArray<{ hash: string; name: string }>): Promise<void> {
	await conn.batch(hashStatements(files))
}

export { hashStatements, historyTable, literal, namesOf, quoteName, readHistory, recordHashes, type Rows }
