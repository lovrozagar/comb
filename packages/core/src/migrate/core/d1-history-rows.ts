/**
 * The rows of a D1 database's history, as comb reads and writes them through wrangler: wrangler's
 * migrations table, comb's hash and intent tables and comb's pre-0.8 `__drizzle_migrations`, which
 * intents a read takes as hashes, and the statements that write them in the order the history's
 * invariant needs.
 */
import { executeAll } from "../drivers/d1.ts"
import { type D1Target, localMissing, type ReadConfig } from "./d1-binding.ts"
import type { d1Files } from "./d1-files.ts"
import { D1_HASH_INTENT_TABLE, D1_HASH_TABLE, DRIZZLE_HISTORY_TABLE } from "./d1-history-tables.ts"
import { foldedMigrationHash, generateMigrationHash, legacyMigrationHash, SPACES_KEPT_SINCE } from "./parse.ts"

const quoteName = (name: string): string => `"${name.replaceAll('"', '""')}"`
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`

/** wrangler's own migrations table, made as wrangler makes it */
const historyTable = (table: string): string =>
	`CREATE TABLE IF NOT EXISTS ${quoteName(table)} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`

/** The names the migrations table `table` records, in order */
const namesOf = (table: string): string => `SELECT name, applied_at FROM ${quoteName(table)} ORDER BY id`

/** One statement's rows, as executeAll answers them */
type Rows = Array<Record<string, unknown>>

/**
 * What the history tables hold: wrangler's names and when it applied each, comb's hashes and intents,
 * and comb's pre-0.8 record; the intents and that record undefined where their table is absent
 */
type HistoryRead = {
	applied: Set<string>
	/** when wrangler applied each name (ms; NaN when its applied_at is not one), which dates comb's hash for it (SL5 of r22) */
	appliedAt: Map<string, number>
	drizzle: Set<string> | undefined
	intents: Map<string, string> | undefined
	recorded: Map<string, string>
}

/** What a database comb never reached holds: no history at all */
const noHistory = (): HistoryRead => ({
	applied: new Set(),
	appliedAt: new Map(),
	drizzle: undefined,
	intents: undefined,
	recorded: new Map(),
})

/** `rows` of name and hash, by name */
/** wrangler's applied_at, SQLite's CURRENT_TIMESTAMP (`2026-11-03 19:00:00`, UTC), in ms */
const utcTime = (value: unknown): number => Date.parse(`${String(value).replace(" ", "T")}Z`)

const byName = (rows: Rows) => new Map(rows.map((row) => [String(row["name"]), String(row["hash"])]))

/**
 * The history in as few wrangler calls as it takes, each a process of its own (R1): a listing says
 * which tables exist, and one more call reads those. Nothing is made: apply and baseline write their
 * tables only once every check has passed (S5 of the 0.15.0 review), and a local database wrangler
 * keeps nowhere yet holds no history, read without a call that would create it.
 */
function readHistory(read: ReadConfig, target: D1Target, table: string): HistoryRead {
	if (localMissing(read, target)) return noHistory()
	const [names, hashes, intents, drizzle] = [
		namesOf(table),
		`SELECT name, hash FROM ${D1_HASH_TABLE}`,
		`SELECT name, hash FROM ${D1_HASH_INTENT_TABLE}`,
		`SELECT hash FROM ${DRIZZLE_HISTORY_TABLE}`,
	]
	const tables = [table, D1_HASH_TABLE, D1_HASH_INTENT_TABLE, DRIZZLE_HISTORY_TABLE]
	const listing = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(literal).join(", ")})`
	/* executeAll answers one result per statement, or throws */
	const present = new Set((executeAll(target.exec, target, [listing])[0] as Rows).map((row) => String(row["name"])))
	const later = [names, hashes, intents, drizzle].filter((_, i) => present.has(tables[i] as string))
	const rows = new Map<string, Rows>()
	if (later.length > 0) executeAll(target.exec, target, later).forEach((each, i) => rows.set(later[i] as string, each))
	const at = (sql: string) => rows.get(sql) ?? []
	return {
		applied: new Set(at(names).map((row) => String(row["name"]))),
		appliedAt: new Map(at(names).map((row) => [String(row["name"]), utcTime(row["applied_at"])])),
		drizzle: present.has(DRIZZLE_HISTORY_TABLE) ? new Set(at(drizzle).map((row) => String(row["hash"]))) : undefined,
		intents: present.has(D1_HASH_INTENT_TABLE) ? byName(at(intents)) : undefined,
		recorded: byName(at(hashes)),
	}
}

type Hashed = ReadonlyArray<{ hash: string; name: string }>

/**
 * The statements that record the hash each of `files` was applied under, comb's table made first.
 * The invariant every writer keeps (S2, S3 of r19): a name is in wrangler's table only once its hash
 * or its intent is in comb's. A hash row is proof of what ran, so only a file wrangler's table names
 * gets one; a pending file gets an intent (intentStatements)
 */
const hashStatements = (files: Hashed): Array<{ sql: string }> => [
	{ sql: `CREATE TABLE IF NOT EXISTS ${D1_HASH_TABLE} (name TEXT PRIMARY KEY, hash TEXT NOT NULL)` },
	...files.map(({ hash, name }) => ({
		sql: `INSERT OR REPLACE INTO ${D1_HASH_TABLE} (name, hash) VALUES (${literal(name)}, ${literal(hash)})`,
	})),
]

/**
 * The statements that record the hash each pending file of `files` is about to be applied under, as
 * an intent: never proof of what ran, as wrangler may run the file after an edit (S1 of r20). An
 * intent whose name wrangler's table lacks is inert, and a read takes one whose name it has only
 * while it is the file's current hash (d1-history.ts)
 */
const intentStatements = (files: Hashed): Array<{ sql: string }> => [
	{ sql: `CREATE TABLE IF NOT EXISTS ${D1_HASH_INTENT_TABLE} (name TEXT PRIMARY KEY, hash TEXT NOT NULL)` },
	...files.map(({ hash, name }) => ({
		sql: `INSERT OR REPLACE INTO ${D1_HASH_INTENT_TABLE} (name, hash) VALUES (${literal(name)}, ${literal(hash)})`,
	})),
]

/**
 * The statements that record `hashed`'s hashes, then clear every intent, when `intents` says the
 * intent table is there: in that order, so a batch cut short leaves each name its intent or its hash
 */
const settleStatements = (hashed: Hashed, intents: boolean): Array<{ sql: string }> => [
	...(hashed.length > 0 ? hashStatements(hashed) : []),
	...(intents ? [{ sql: `DELETE FROM ${D1_HASH_INTENT_TABLE}` }] : []),
]

/**
 * The intents of applied files comb records no hash for, each its file's
 * current hash: a lost move left them, and each is the hash wrangler ran its file under. A history
 * read takes them as recorded and writes nothing; the next apply or baseline records them. An
 * intent that is not its file's current hash is not: that file was edited before wrangler ran it,
 * and is read as applied before comb recorded it (S1 of r20)
 */
function settled(
	files: ReturnType<typeof d1Files>,
	{ applied, intents, recorded }: ReturnType<typeof readHistory>,
): { hasIntents: boolean; settle: Hashed } {
	const settle = files
		.filter(({ name }) => applied.has(name) && !recorded.has(name))
		.map(({ name, sql }) => ({ hash: generateMigrationHash(sql), name }))
		.filter(({ hash, name }) => intents?.get(name) === hash)
	return { hasIntents: (intents?.size ?? 0) > 0, settle }
}

/**
 * Record the hashes of `moved`, the files wrangler's table now names, and clear every intent, in one
 * batch; the message of a batch that failed, which leaves each name its intent or its hash
 */
async function moveIntents(conn: D1Target["conn"], moved: Hashed): Promise<string | undefined> {
	try {
		await conn.batch(settleStatements(moved, true))
		return undefined
	} catch (error) {
		return (error as Error).message
	}
}

/**
 * Whether `hash`, recorded for a file of text `sql`, is that text: its current hash; its folded one
 * (0.5.0 to 0.20) where wrangler applied the file, in the apply that recorded the hash, before comb
 * kept the spaces SQLite reads as part of a name (SL5 of r22); or its pre-0.5.0 one where comb's
 * pre-0.8 history (`drizzle`) still holds it, proof the record is from before 0.5.0, as a 0.13
 * baseline copied it (M44)
 */
function vouched(
	sql: string,
	hash: string,
	{ appliedAt, drizzle }: { appliedAt: number; drizzle: ReadonlySet<string> | undefined },
): boolean {
	if (hash === generateMigrationHash(sql)) return true
	if (hash === foldedMigrationHash(sql)) return appliedAt < SPACES_KEPT_SINCE
	return hash === legacyMigrationHash(sql) && drizzle?.has(hash) === true
}

export {
	vouched,
	type Hashed,
	hashStatements,
	historyTable,
	intentStatements,
	literal,
	moveIntents,
	namesOf,
	quoteName,
	readHistory,
	type Rows,
	settled,
	settleStatements,
}
