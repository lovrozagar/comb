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
import { foldedMigrationHash, generateMigrationHash, HASH_VERSION, legacyMigrationHash } from "./parse.ts"

const quoteName = (name: string): string => `"${name.replaceAll('"', '""')}"`
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`

/** wrangler's own migrations table, made as wrangler makes it */
const historyTable = (table: string): string =>
	`CREATE TABLE IF NOT EXISTS ${quoteName(table)} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`

/** The names the migrations table `table` records, in order */
const namesOf = (table: string): string => `SELECT name FROM ${quoteName(table)} ORDER BY id`

/** One statement's rows, as executeAll answers them */
type Rows = Array<Record<string, unknown>>

/** A hash comb recorded for a file, and whether `hash_v` marks it as this comb's, the exact hash (parse.ts HASH_VERSION) */
type Recorded = { hash: string; marked: boolean }

/**
 * What the history tables hold: wrangler's names, comb's hashes and intents, and comb's pre-0.8
 * record; the intents and that record undefined where their table is absent; `marks` unless comb's
 * hash table is one 0.20 or earlier made, without `hash_v`, which the first write adds
 */
type HistoryRead = {
	applied: Set<string>
	drizzle: Set<string> | undefined
	intents: Map<string, string> | undefined
	marks: boolean
	recorded: Map<string, Recorded>
}

/** What a database comb never reached holds: no history at all */
const noHistory = (): HistoryRead => ({
	applied: new Set(),
	drizzle: undefined,
	intents: undefined,
	marks: true,
	recorded: new Map(),
})

/** `rows` of name and hash, by name */
const byName = (rows: Rows) => new Map(rows.map((row) => [String(row["name"]), String(row["hash"])]))

/**
 * The history in as few wrangler calls as it takes, each a process of its own: a listing says
 * which tables exist, and whether comb's hash table has `hash_v`, and one more call reads those. Nothing is made: apply and baseline write their
 * tables only once every check has passed, and a local database wrangler
 * keeps nowhere yet holds no history, read without a call that would create it.
 */
async function readHistory(read: ReadConfig, target: D1Target, table: string): Promise<HistoryRead> {
	if (localMissing(read, target)) return noHistory()
	const tables = [table, D1_HASH_TABLE, D1_HASH_INTENT_TABLE, DRIZZLE_HISTORY_TABLE]
	const listing = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(literal).join(", ")})`
	/* the PRAGMA statement D1 documents as allowed; it answers no row for a table that does not exist */
	const versioned = `PRAGMA table_info(${literal(D1_HASH_TABLE)})`
	/* executeAll answers one result per statement, or throws */
	const [listed, columns] = await executeAll(target.exec, target, [listing, versioned])
	const present = new Set((listed as Rows).map((row) => String(row["name"])))
	const marks = !present.has(D1_HASH_TABLE) || (columns as Rows).some((row) => row["name"] === "hash_v")
	const [names, hashes, intents, drizzle] = [
		namesOf(table),
		`SELECT name, hash, ${marks ? "hash_v" : "NULL AS hash_v"} FROM ${D1_HASH_TABLE}`,
		`SELECT name, hash FROM ${D1_HASH_INTENT_TABLE}`,
		`SELECT hash FROM ${DRIZZLE_HISTORY_TABLE}`,
	]
	const later = [names, hashes, intents, drizzle].filter((_, i) => present.has(tables[i] as string))
	const rows = new Map<string, Rows>()
	if (later.length > 0)
		(await executeAll(target.exec, target, later)).forEach((each, i) => rows.set(later[i] as string, each))
	const at = (sql: string) => rows.get(sql) ?? []
	return {
		applied: new Set(at(names).map((row) => String(row["name"]))),
		drizzle: present.has(DRIZZLE_HISTORY_TABLE) ? new Set(at(drizzle).map((row) => String(row["hash"]))) : undefined,
		intents: present.has(D1_HASH_INTENT_TABLE) ? byName(at(intents)) : undefined,
		marks,
		recorded: new Map(
			at(hashes).map((row) => [
				String(row["name"]),
				{ hash: String(row["hash"]), marked: Number(row["hash_v"]) === HASH_VERSION },
			]),
		),
	}
}

/**
 * Hashes to record, each `marked` when it is the exact hash of the text this comb checked, and
 * unmarked when copied from a record comb 0.20 or earlier made
 */
type Hashed = ReadonlyArray<{ hash: string; marked: boolean; name: string }>

/** comb's hash table, made with `hash_v`, which a table 0.20 or earlier made gains unless it `marks` already */
const hashTable = (marks: boolean): Array<{ sql: string }> => [
	{ sql: `CREATE TABLE IF NOT EXISTS ${D1_HASH_TABLE} (name TEXT PRIMARY KEY, hash TEXT NOT NULL, hash_v INTEGER)` },
	...(marks ? [] : [{ sql: `ALTER TABLE ${D1_HASH_TABLE} ADD COLUMN hash_v INTEGER` }]),
]

/**
 * The statements that record the hash each of `files` was applied under, comb's table made first, or
 * given `hash_v` where it lacks it (`marks`).
 * The invariant every writer keeps: a name is in wrangler's table only once its hash
 * or its intent is in comb's. A hash row is proof of what ran, so only a file wrangler's table names
 * gets one; a pending file gets an intent (intentStatements)
 */
const hashStatements = (files: Hashed, marks: boolean): Array<{ sql: string }> => [
	...hashTable(marks),
	...files.map(({ hash, marked, name }) => ({
		sql: `INSERT OR REPLACE INTO ${D1_HASH_TABLE} (name, hash, hash_v) VALUES (${literal(name)}, ${literal(hash)}, ${marked ? HASH_VERSION : "NULL"})`,
	})),
]

/**
 * The statements that record the hash each pending file of `files` is about to be applied under, as
 * an intent: never proof of what ran, as wrangler may run the file after an edit. An
 * intent whose name wrangler's table lacks is inert, and a read takes one whose name it has only
 * while it is the file's current hash (d1-history.ts)
 */
const intentStatements = (files: ReadonlyArray<{ hash: string; name: string }>): Array<{ sql: string }> => [
	{ sql: `CREATE TABLE IF NOT EXISTS ${D1_HASH_INTENT_TABLE} (name TEXT PRIMARY KEY, hash TEXT NOT NULL)` },
	...files.map(({ hash, name }) => ({
		sql: `INSERT OR REPLACE INTO ${D1_HASH_INTENT_TABLE} (name, hash) VALUES (${literal(name)}, ${literal(hash)})`,
	})),
]

/**
 * The statements that record `hashed`'s hashes, then clear every intent, when `intents` says the
 * intent table is there: in that order, so a batch cut short leaves each name its intent or its hash
 */
const settleStatements = (hashed: Hashed, intents: boolean, marks: boolean): Array<{ sql: string }> => [
	...(hashed.length > 0 ? hashStatements(hashed, marks) : []),
	...(intents ? [{ sql: `DELETE FROM ${D1_HASH_INTENT_TABLE}` }] : []),
]

/**
 * The intents of applied files comb records no hash for, each its file's
 * current hash: a lost move left them, and each is the hash wrangler ran its file under. A history
 * read takes them as recorded and writes nothing; the next apply or baseline records them. An
 * intent that is not its file's current hash is not: that file was edited before wrangler ran it,
 * and is read as applied before comb recorded it
 */
function settled(
	files: ReturnType<typeof d1Files>,
	{ applied, intents, recorded }: Awaited<ReturnType<typeof readHistory>>,
): { hasIntents: boolean; settle: Hashed } {
	const settle = files
		.filter(({ name }) => applied.has(name) && !recorded.has(name))
		.map(({ name, sql }) => ({ hash: generateMigrationHash(sql), marked: true, name }))
		.filter(({ hash, name }) => intents?.get(name) === hash)
	return { hasIntents: (intents?.size ?? 0) > 0, settle }
}

/**
 * Record the hashes of `moved`, the files wrangler's table now names, and clear every intent, in one
 * batch; the message of a batch that failed, which leaves each name its intent or its hash
 */
async function moveIntents(conn: D1Target["conn"], moved: Hashed, marks: boolean): Promise<string | undefined> {
	try {
		await conn.batch(settleStatements(moved, true, marks))
		return undefined
	} catch (error) {
		return (error as Error).message
	}
}

/**
 * Whether `recorded`, the hash comb holds for a file of text `sql`, is that text: its current hash;
 * on a record `hash_v` does not mark, which comb 0.20 or earlier wrote, its folded one (0.5.0 to
 * 0.20) or its pre-0.5.0 one where comb's pre-0.8 history (`drizzle`) still holds it, proof the
 * record is from before 0.5.0, as a 0.13 baseline copied it
 */
const vouched = (sql: string, { hash, marked }: Recorded, drizzle: ReadonlySet<string> | undefined): boolean =>
	hash === generateMigrationHash(sql) ||
	(!marked && (hash === foldedMigrationHash(sql) || (hash === legacyMigrationHash(sql) && drizzle?.has(hash) === true)))

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
	type Recorded,
	type Rows,
	settled,
	settleStatements,
}
