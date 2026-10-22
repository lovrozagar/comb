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
import { notEngineTables } from "./engine-tables.ts"
import { compare, type Shape } from "./proof-compare.ts"
import { quote, seedTables } from "./proof-seed.ts"

/** What the proof run found for one file */
type Proof = {
	cautious: string[]
	/** why the file did not apply to the copy, so nothing about it is proven */
	failed?: string | undefined
	/** the tables comb could not seed, which nothing here proves, each with why */
	unproven: Array<{ table: string; why: string }>
	unsafe: string[]
}

/** One object of the live schema */
type LiveObject = { name: string; sql: string; type: string }

/* the shadow tables FTS3/4/5 and R*Tree make for a virtual table, which creating it makes again */
const SHADOWS = ["config", "content", "data", "docsize", "idx", "node", "parent", "rowid", "segdir", "segments", "stat"]

/** The target's schema, read in one SELECT: SQLite's and D1's own objects left out */
async function liveObjects(conn: Connection): Promise<LiveObject[]> {
	const { columns, rows } = await conn.execute(
		`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL${notEngineTables(conn)} ORDER BY rowid`,
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
function buildCopy(db: MemoryDb, objects: readonly LiveObject[], variant = 0): Map<string, string> {
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
	for (const [table, why] of seedTables(db, new Map(seedable.map((object) => [object.name, object.sql])), variant))
		unproven.set(table.toLowerCase(), why)
	for (const object of objects.filter((each) => each.type === "trigger" || each.type === "view")) make(object)
	return unproven
}

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

/** One copy of the target: its database, and the tables comb could not seed in it, with why */
type Copy = { db: MemoryDb; unproven: Map<string, string> }

/** A copy of `objects`, seeded as seed `variant` */
async function copyOf(objects: readonly LiveObject[], variant: number): Promise<Copy> {
	const db = await openMemory()
	return { db, unproven: buildCopy(db, objects, variant) }
}

/**
 * A fresh copy, reseeded with values the first seed never held, the files that applied before
 * replayed on it; undefined, and closed, when one of them no longer applies
 */
async function reseeded(objects: readonly LiveObject[], applied: readonly string[]): Promise<Copy | undefined> {
	const copy = await copyOf(objects, 1)
	if (applied.every((sql) => applyToCopy(copy.db, sql) === undefined)) return copy
	copy.db.close()
	return undefined
}

/**
 * Prove each pending file, in order, on a seeded in-memory copy of the database `conn` reaches;
 * returns each file's proof by name. A file the copy refuses is tried once more on a reseeded copy
 * (a seed's value can meet a file's unique index or explicit id); a file refused both ways proves
 * nothing, nor does any after it, and their ratings are the classifier's.
 */
async function provePending(
	conn: Connection,
	files: ReadonlyArray<{ name: string; sql: string }>,
): Promise<Map<string, Proof>> {
	const objects = creatable(await liveObjects(conn))
	let copy = await copyOf(objects, 0)
	const proofs = new Map<string, Proof>()
	const applied: string[] = []
	let failed: string | undefined
	try {
		for (const { name, sql } of files) {
			if (failed !== undefined) {
				proofs.set(name, { cautious: [], failed, unproven: unprovenOf(copy), unsafe: [] })
				continue
			}
			let before = snapshot(copy.db)
			let error = applyToCopy(copy.db, sql)
			const retry = error === undefined ? undefined : await reseeded(objects, applied)
			if (retry !== undefined) {
				copy.db.close()
				copy = retry
				before = snapshot(copy.db)
				error = applyToCopy(copy.db, sql)
			}
			if (error !== undefined) {
				failed = `an earlier pending file, ${name}, did not apply to the copy`
				proofs.set(name, {
					cautious: [],
					failed: `it did not apply to the copy, reseeded or not: ${error}`,
					unproven: unprovenOf(copy),
					unsafe: [],
				})
				continue
			}
			applied.push(sql)
			const found = compare(
				copy.db,
				new Map([...before].filter(([table]) => !copy.unproven.has(table))),
				snapshot(copy.db),
			)
			proofs.set(name, { ...found, unproven: unprovenOf(copy) })
		}
	} finally {
		copy.db.close()
	}
	return proofs
}

/** The tables a copy could not seed, as a proof lists them */
const unprovenOf = (copy: Copy) => [...copy.unproven].map(([table, why]) => ({ table, why }))

export { type Proof, provePending }
