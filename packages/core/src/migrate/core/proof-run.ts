/**
 * The proof run, on the SQLite family (bun:sqlite, libsql, D1): before a check or an apply, each
 * pending file runs on a private in-memory copy of the target's live schema, seeded with rows that
 * show any change (proof-seed.ts), and every table that was there before is compared, row for row,
 * on the columns it had, as a multiset of whole rows. A lost row, a lost column or a changed value
 * makes the file unsafe, and the reason names the table and column. One allowance: a NULL that lands as the column's new
 * DEFAULT, in a column the file made NOT NULL, is cautious (Atlas's "make NOT NULL with a
 * default" rebuild). A table comb cannot seed is unproven, and its rating stays the classifier's.
 * The target is only read: its schema, through one SELECT.
 *
 * The proof only adds strictness. Its rows are synthetic, so they cannot meet every predicate a
 * file holds: `DELETE FROM u WHERE email LIKE '%@%'` proves clean, as no seeded email has an @.
 * The classifier stays authoritative, and no classifier rule is ever relaxed because a proof passed.
 */
import { openMemory, type MemoryDb } from "../drivers/memory.ts"
import type { Connection } from "../types.ts"
import { quote, seedTables } from "./proof-seed.ts"

/** What the proof run found for one file */
type Proof = {
	cautious: string[]
	/** why the file did not apply to the copy, so nothing about it is proven */
	failed?: string | undefined
	/** the tables comb could not seed, which nothing here proves */
	unproven: string[]
	unsafe: string[]
}

/** One object of the live schema */
type LiveObject = { name: string; sql: string; type: string }

/* the shadow tables FTS3/4/5 and R*Tree make for a virtual table, which creating it makes again */
const SHADOWS = ["config", "content", "data", "docsize", "idx", "node", "parent", "rowid", "segdir", "segments", "stat"]

/** The target's schema, read in one SELECT: SQLite's and D1's own objects left out */
async function liveObjects(conn: Connection): Promise<LiveObject[]> {
	const { columns, rows } = await conn.execute(
		"SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY rowid",
	)
	const at = (name: string) => columns.indexOf(name)
	return rows.map((row) => ({
		name: String(row[at("name")]),
		sql: String(row[at("sql")]),
		type: String(row[at("type")]),
	}))
}

const isVirtual = (object: LiveObject) => /^CREATE VIRTUAL TABLE\b/i.test(object.sql)
/* an external-content or contentless FTS table mirrors another table: its rows prove nothing of their own */
const isMirror = (object: LiveObject) => isVirtual(object) && /\bcontent\s*=\s*'/i.test(object.sql)

/** The objects the copy creates: every one but a virtual table's shadow tables */
function creatable(objects: readonly LiveObject[]): LiveObject[] {
	const virtual = objects.filter(isVirtual).map((object) => object.name.toLowerCase())
	const shadow = (name: string) => virtual.some((table) => SHADOWS.some((suffix) => name === `${table}_${suffix}`))
	return objects.filter((object) => !(object.type === "table" && shadow(object.name.toLowerCase())))
}

/**
 * The copy: tables and indexes, then the seed, then triggers and views, as the database has them;
 * returns the tables it could not create or seed, with why
 */
function buildCopy(db: MemoryDb, objects: readonly LiveObject[]): Map<string, string> {
	const unproven = new Map<string, string>()
	const make = (object: LiveObject) => {
		try {
			db.exec(object.sql)
		} catch (error) {
			// reason: what the copy cannot create, nothing proves; the table is listed unproven with why
			unproven.set(object.name.toLowerCase(), `comb could not create it in the copy: ${(error as Error).message}`)
		}
	}
	const tables = objects.filter((each) => each.type === "table")
	for (const object of [...tables, ...objects.filter((each) => each.type === "index")]) make(object)
	const seedable = tables.filter(
		(object) =>
			!unproven.has(object.name.toLowerCase()) &&
			(!isVirtual(object) || /\busing fts5\b/i.test(object.sql)) &&
			!isMirror(object),
	)
	for (const object of tables.filter((each) => isVirtual(each) && !seedable.includes(each) && !isMirror(each)))
		unproven.set(object.name.toLowerCase(), "a virtual table comb does not seed")
	for (const [table, why] of seedTables(db, new Map(seedable.map((object) => [object.name, object.sql]))))
		unproven.set(table.toLowerCase(), why)
	for (const object of objects.filter((each) => each.type === "trigger" || each.type === "view")) make(object)
	return unproven
}

/** One table as the proof compares it: its stored columns, whether each may hold NULL, its default, and its rows */
type Shape = { columns: string[]; defaults: Map<string, string | null>; nullable: Set<string>; rows: string[][] }

/** Every table of the copy but a mirror FTS table, each with its stored columns and rows (each value as SQLite quotes it) */
function snapshot(db: MemoryDb): Map<string, Shape> {
	const out = new Map<string, Shape>()
	const tables = db.all(
		"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
	)
	const live = creatable(tables.map((row) => ({ name: String(row["name"]), sql: String(row["sql"]), type: "table" })))
	for (const { name } of live.filter((object) => !isMirror(object))) {
		const info = db.all(`PRAGMA table_xinfo(${quote(name)})`).filter((row) => row["hidden"] === 0)
		const columns = info.map((row) => String(row["name"]))
		const rows = db
			.all(
				`SELECT ${columns.map((column) => `quote(${quote(column)}) AS ${quote(column)}`).join(", ")} FROM ${quote(name)}`,
			)
			.map((row) => columns.map((column) => String(row[column])))
		out.set(name.toLowerCase(), {
			columns,
			defaults: new Map(
				info.map((row) => [String(row["name"]), row["dflt_value"] === null ? null : String(row["dflt_value"])]),
			),
			nullable: new Set(
				info.filter((row) => row["notnull"] === 0 && row["pk"] === 0).map((row) => String(row["name"])),
			),
			rows,
		})
	}
	return out
}

/** What a file did to the tables before it: the proof's findings without what it could not prove */
type Findings = Pick<Proof, "cautious" | "unsafe">

/** Each value of `keys`, with how many times it occurs */
function counts(keys: readonly string[]): Map<string, number> {
	const out = new Map<string, number>()
	for (const key of keys) out.set(key, (out.get(key) ?? 0) + 1)
	return out
}

/** How many of `before` are not in `after`, each counted as often as it occurs */
function missing(before: readonly string[], after: readonly string[]): number {
	const held = counts(after)
	return [...counts(before)].reduce((sum, [key, n]) => sum + Math.max(0, n - (held.get(key) ?? 0)), 0)
}

/**
 * The one allowance: each column the file made NOT NULL with a DEFAULT, which was nullable, with
 * that default as SQLite quotes it. Atlas's "make NOT NULL with a default" rebuild fills its NULLs so.
 */
function allowedDefaults(db: MemoryDb, { now, was }: { now: Shape; was: Shape }): Map<string, string> {
	const out = new Map<string, string>()
	for (const column of was.columns) {
		const fresh = now.defaults.get(column)
		if (!was.nullable.has(column) || now.nullable.has(column) || fresh === null || fresh === undefined) continue
		out.set(column, String(db.all(`SELECT quote(${fresh}) AS v`)[0]?.["v"]))
	}
	return out
}

/** Each row of `shape` as one key over `columns`, a NULL in a column of `fill` read as its default */
function rowKeys(shape: Shape, columns: readonly string[], fill: ReadonlyMap<string, string> = new Map()): string[] {
	const at = columns.map((column) => shape.columns.indexOf(column))
	return shape.rows.map((row) =>
		JSON.stringify(
			columns.map((column, i) => {
				const value = row[at[i] as number] as string
				return value === "NULL" ? (fill.get(column) ?? value) : value
			}),
		),
	)
}

/**
 * The columns whose values a file changed: those whose own values differ, else those whose
 * leaving out makes the rows match (a value moved between rows keeps the column's values)
 */
function changedColumns(was: Shape, now: Shape, fill: ReadonlyMap<string, string>): string[] {
	const columns = was.columns.filter((each) => now.columns.includes(each))
	const differs = (picked: readonly string[]) => missing(rowKeys(was, picked, fill), rowKeys(now, picked)) > 0
	const own = columns.filter((column) => differs([column]))
	return own.length > 0 ? own : columns.filter((column) => !differs(columns.filter((each) => each !== column)))
}

/**
 * What a file did to one table that was there before it, compared as a multiset of whole rows over
 * the columns it had: so a value copied, swapped or moved between rows shows, not only one lost
 */
function compareTable(db: MemoryDb, table: string, { now, was }: { now: Shape; was: Shape }): Findings {
	const out: Findings = { cautious: [], unsafe: [] }
	for (const column of was.columns.filter((each) => !now.columns.includes(each)))
		out.unsafe.push(`loses ${table}.${column}`)
	if (now.rows.length < was.rows.length)
		out.unsafe.push(`loses ${was.rows.length - now.rows.length} of ${table}'s ${was.rows.length} rows`)
	const columns = was.columns.filter((each) => now.columns.includes(each))
	const fill = allowedDefaults(db, { now, was })
	if (missing(rowKeys(was, columns, fill), rowKeys(now, columns)) === 0) {
		const nulls = [...fill.keys()].filter((column) =>
			was.rows.some((row) => row[was.columns.indexOf(column)] === "NULL"),
		)
		for (const column of nulls) out.cautious.push(`fills ${table}.${column}'s NULLs with its default`)
		return out
	}
	const changed = changedColumns(was, now, fill)
	if (changed.length === 0) out.unsafe.push(`changes rows of ${table}`)
	for (const column of changed) out.unsafe.push(`changes values of ${table}.${column}`)
	return out
}

/** What a file did to each table that was there before it */
function compare(db: MemoryDb, before: ReadonlyMap<string, Shape>, after: ReadonlyMap<string, Shape>): Findings {
	const out: Findings = { cautious: [], unsafe: [] }
	for (const [table, was] of before) {
		const now = after.get(table)
		if (now === undefined) out.unsafe.push(`loses every row of ${table}`)
		else {
			const found = compareTable(db, table, { now, was })
			out.cautious.push(...found.cautious)
			out.unsafe.push(...found.unsafe)
		}
	}
	return out
}

/** Apply one file to the copy, as the target would: foreign keys on, the file in one transaction */
function applyToCopy(db: MemoryDb, sql: string): string | undefined {
	try {
		db.exec("PRAGMA foreign_keys = ON")
		db.exec("BEGIN")
		db.exec(sql)
		db.exec("COMMIT")
		return undefined
	} catch (error) {
		db.exec("ROLLBACK")
		return (error as Error).message
	}
}

/**
 * Prove each pending file, in order, on a seeded in-memory copy of the database `conn` reaches;
 * returns each file's proof by name. A file that does not apply to the copy proves nothing, nor
 * does any after it.
 */
async function provePending(
	conn: Connection,
	files: ReadonlyArray<{ name: string; sql: string }>,
): Promise<Map<string, Proof>> {
	const db = await openMemory()
	const proofs = new Map<string, Proof>()
	try {
		const unproven = buildCopy(db, creatable(await liveObjects(conn)))
		let failed: string | undefined
		for (const { name, sql } of files) {
			const before = snapshot(db)
			const unprovenHere = [...unproven.keys()]
			if (failed !== undefined) {
				proofs.set(name, { cautious: [], failed, unproven: unprovenHere, unsafe: [] })
				continue
			}
			const error = applyToCopy(db, sql)
			if (error !== undefined) {
				failed = `an earlier pending file, ${name}, did not apply to the copy`
				proofs.set(name, {
					cautious: [],
					failed: `it did not apply to the copy: ${error}`,
					unproven: unprovenHere,
					unsafe: [],
				})
				continue
			}
			const found = compare(db, new Map([...before].filter(([table]) => !unproven.has(table))), snapshot(db))
			proofs.set(name, { ...found, unproven: unprovenHere })
		}
	} finally {
		db.close()
	}
	return proofs
}

export { type Proof, provePending }
