/**
 * The proof run, on the SQLite family (bun:sqlite, libsql, D1): before a check or an apply, each
 * pending file runs on a private in-memory copy of the target's live schema, seeded with rows that
 * show any change (proof-seed.ts), and every table that was there before is compared, row for row,
 * on the columns it had, as a multiset of whole rows. A lost row, a lost column or a changed value
 * makes the file unsafe, and the reason names the table and column. One allowance: a NULL that
 * lands as the column's new DEFAULT, in a column the file made NOT NULL, is cautious (Atlas's "make
 * NOT NULL with a default" rebuild). A table comb cannot seed is unproven, and its rating stays the
 * classifier's. The target is only read: its schema, through one SELECT.
 *
 * Seeded rows cannot meet every predicate a file holds, so what each statement writes is read from
 * SQLite itself as it runs (proof-engine.ts): an update of a column that was there before, a
 * delete, a trigger fired or a temp shadow is unsafe whichever rows it meets, and a backfill of the
 * file's own columns is cautious. A file the copy cannot run is unproven, and unproven is unsafe.
 */
import { isMirror, mirrorFindings, mirrorRows, seedMirrors } from "./proof-mirror.ts"
import { openMemory, type MemoryDb } from "../drivers/memory.ts"
import type { Connection } from "../types.ts"
import { notEngineTables } from "./engine-tables.ts"
import { compare, type Shape } from "./proof-compare.ts"
import { applyToCopy, engineFindings } from "./proof-engine.ts"
import { quote, seedTables } from "./proof-seed.ts"
import { asciiFold } from "./sql-code.ts"

/** What the proof run found for one file */
type Proof = {
	cautious: string[]
	/** why the file did not apply to the copy, so nothing about it is proven */
	failed?: string | undefined
	/** the tables comb could not seed, which nothing here proves, each with why */
	unproven: Array<{ table: string; why: string }>
	unsafe: string[]
}

/** One object of the live schema, and the table it belongs to (sqlite_master's tbl_name) */
type LiveObject = { name: string; sql: string; table: string; type: string }

// lookup-table: the shadow tables each module makes beside its virtual table, which creating it makes again
const SHADOWS: Readonly<Record<string, readonly string[]>> = {
	fts3: ["content", "docsize", "segdir", "segments", "stat"],
	fts4: ["content", "docsize", "segdir", "segments", "stat"],
	fts5: ["config", "content", "data", "docsize", "idx"],
	geopoly: ["node", "parent", "rowid"],
	rtree: ["node", "parent", "rowid"],
	rtree_i32: ["node", "parent", "rowid"],
	spellfix1: ["vocab"],
}

/** The target's schema, read in one SELECT: SQLite's and D1's own objects left out */
async function liveObjects(conn: Connection, engine: string): Promise<LiveObject[]> {
	const { columns, rows } = await conn.execute(
		`SELECT type, name, sql, tbl_name FROM sqlite_master WHERE sql IS NOT NULL${engine} ORDER BY rowid`,
	)
	const at = (name: string) => columns.indexOf(name)
	return rows.map((row) => ({
		name: String(row[at("name")]),
		sql: String(row[at("sql")]),
		table: String(row[at("tbl_name")]),
		type: String(row[at("type")]),
	}))
}

const isVirtual = (object: LiveObject) => /^CREATE VIRTUAL TABLE\b/i.test(object.sql)

/** The objects the copy creates: every one but a virtual table's own module's shadow tables */
function creatable(objects: readonly LiveObject[]): LiveObject[] {
	const shadows = new Set(
		objects.filter(isVirtual).flatMap((object) => {
			/* a CREATE VIRTUAL TABLE names its module */
			const module = (/\bUSING\s+(\w+)/i.exec(object.sql) as RegExpExecArray)[1]?.toLowerCase() as string
			return (SHADOWS[module] ?? []).map((suffix) => asciiFold(`${object.name}_${suffix}`))
		}),
	)
	return objects.filter((object) => !(object.type === "table" && shadows.has(asciiFold(object.name))))
}

/** The columns, by lower-case name, a pending file reads with a `json_*` function: the seed holds JSON there */
function jsonColumns(files: ReadonlyArray<{ sql: string }>): Set<string> {
	/* a json_* function's first argument, or the column before a -> or ->> */
	const call = /\bjson\w*\s*\(\s*(?:["`[]?\w+["`\]]?\s*\.\s*)?["`[]?(\w+)/gi
	const arrow = /(?:["`[]?\w+["`\]]?\s*\.\s*)?["`[]?(\w+)["`\]]?\s*->>?/g
	return new Set(
		files.flatMap(({ sql }) =>
			[...sql.matchAll(call), ...sql.matchAll(arrow)].map((match) => asciiFold(match[1] as string)),
		),
	)
}

/** Why a table is unproven when the copy cannot create `object`: none for a view, which holds no rows */
function uncreated(object: LiveObject, message: string): [table: string, why: string] | undefined {
	if (object.type === "view") return undefined
	if (object.type === "trigger")
		return [asciiFold(object.table), `its trigger ${object.name} could not be created: ${message}`]
	return [asciiFold(object.table), `comb could not create it in the copy: ${message}`]
}

/** How a copy is seeded: which seed, and the columns pending files read as JSON; none for a copy of the schema alone */
type Seed = { json: ReadonlySet<string>; variant: number } | undefined

/**
 * The copy: tables and indexes, then the seed, then triggers and views, as the database has them;
 * returns the tables it could not create or seed, or whose trigger it could not create, with why
 */
function buildCopy(db: MemoryDb, objects: readonly LiveObject[], seed: Seed): Map<string, string> {
	const unproven = new Map<string, string>()
	const make = (object: LiveObject) => {
		try {
			db.exec(object.sql)
		} catch (error) {
			// reason: what the copy cannot create, nothing proves; its table is listed unproven with why
			const [table, why] = uncreated(object, (error as Error).message) ?? []
			if (table !== undefined && why !== undefined && !unproven.has(table)) unproven.set(table, why)
		}
	}
	const tables = objects.filter((each) => each.type === "table")
	for (const object of [...tables, ...objects.filter((each) => each.type === "index")]) make(object)
	if (seed === undefined) {
		for (const object of objects.filter((each) => each.type === "trigger" || each.type === "view")) make(object)
		return unproven
	}
	const seedable = tables.filter(
		(object) =>
			!unproven.has(asciiFold(object.name)) &&
			(!isVirtual(object) || /\busing fts5\b/i.test(object.sql)) &&
			!isMirror(object),
	)
	for (const object of tables.filter((each) => isVirtual(each) && !seedable.includes(each) && !isMirror(each)))
		unproven.set(asciiFold(object.name), "a virtual table comb does not seed")
	const definitions = new Map(seedable.map((object) => [object.name, object.sql]))
	for (const [table, why] of [...seedTables(db, definitions, seed), ...seedMirrors(db, tables.filter(isMirror))])
		unproven.set(table, why)
	for (const object of objects.filter((each) => each.type === "trigger" || each.type === "view")) make(object)
	return unproven
}

/** Every table of the copy but a mirror FTS table, each with its stored columns and rows (each value as SQLite quotes it) */
function snapshot(db: MemoryDb): Map<string, Shape> {
	const out = new Map<string, Shape>()
	/* main's own: a temp table of the same name would answer for a bare name (M12) */
	const tables = db.all(
		"SELECT name, sql FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
	)
	const live = creatable(
		tables.map((row) => ({
			name: String(row["name"]),
			sql: String(row["sql"]),
			table: String(row["name"]),
			type: "table",
		})),
	)
	for (const { name } of live.filter((object) => !isMirror(object))) {
		const info = db.all(`PRAGMA main.table_xinfo(${quote(name)})`).filter((row) => row["hidden"] === 0)
		const columns = info.map((row) => String(row["name"]))
		const rows = db
			.all(
				`SELECT ${columns.map((column) => `quote(${quote(column)}) AS ${quote(column)}`).join(", ")} FROM main.${quote(name)}`,
			)
			.map((row) => columns.map((column) => String(row[column])))
		out.set(asciiFold(name), {
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

/** One copy of the target: its database, and the tables comb could not seed in it, with why */
type Copy = { db: MemoryDb; unproven: Map<string, string> }

/** A copy of `objects`, seeded as `seed` */
async function copyOf(objects: readonly LiveObject[], seed: NonNullable<Seed>): Promise<Copy> {
	const db = await openMemory()
	return { db, unproven: buildCopy(db, objects, seed) }
}

/**
 * A fresh copy, reseeded with values the first seed never held, the files that applied before
 * replayed on it; undefined, and closed, when one of them no longer applies
 */
async function reseeded(
	objects: readonly LiveObject[],
	applied: readonly string[],
	json: ReadonlySet<string>,
): Promise<Copy | undefined> {
	const copy = await copyOf(objects, { json, variant: 1 })
	if (applied.every((sql) => applyToCopy(copy.db, sql).error === undefined)) return copy
	copy.db.close()
	return undefined
}

/**
 * The schema `files` leave when applied to `objects` with no rows, as the objects of a fresh copy;
 * undefined when one of them fails even there. A file that fails only on the seed's rows (a NOT
 * NULL over a column the seed holds NULLs in, JSON read from seeded text) leaves a schema the later
 * files can be proven on.
 */
async function schemaAfter(
	objects: readonly LiveObject[],
	files: readonly string[],
	engine: string,
): Promise<LiveObject[] | undefined> {
	const db = await openMemory()
	try {
		buildCopy(db, objects, undefined)
		if (!files.every((sql) => applyToCopy(db, sql).error === undefined)) return undefined
		return creatable(
			db
				.all(`SELECT type, name, sql, tbl_name FROM main.sqlite_master WHERE sql IS NOT NULL${engine} ORDER BY rowid`)
				.map((row) => ({
					name: String(row["name"]),
					sql: String(row["sql"]),
					table: String(row["tbl_name"]),
					type: String(row["type"]),
				})),
		)
	} finally {
		db.close()
	}
}

/**
 * Prove each pending file, in order, on a seeded in-memory copy of the database `conn` reaches;
 * returns each file's proof by name. A file the copy refuses is tried once more on a reseeded copy
 * (a seed's value can meet a file's unique index or explicit id); a file refused both ways is
 * unproven, and so unsafe. The later files are proven on the schema it leaves, seeded fresh; when
 * it fails even on a copy with no rows, they are unproven too.
 */
async function provePending(
	conn: Connection,
	files: ReadonlyArray<{ name: string; sql: string }>,
): Promise<Map<string, Proof>> {
	const json = jsonColumns(files)
	/* the engine's own tables, left out of every read of a schema: the target's and the copy's (P4) */
	const engineTables = notEngineTables(conn)
	let objects = creatable(await liveObjects(conn, engineTables))
	let copy = await copyOf(objects, { json, variant: 0 })
	const proofs = new Map<string, Proof>()
	let applied: string[] = []
	let failed: string | undefined
	try {
		for (const { name, sql } of files) {
			if (failed !== undefined) {
				proofs.set(name, { cautious: [], failed, unproven: unprovenOf(copy), unsafe: [failed] })
				continue
			}
			let [before, mirrors] = [snapshot(copy.db), mirrorRows(copy.db)]
			let run = applyToCopy(copy.db, sql)
			const retry = run.error === undefined ? undefined : await reseeded(objects, applied, json)
			if (retry !== undefined) {
				copy.db.close()
				copy = retry
				;[before, mirrors] = [snapshot(copy.db), mirrorRows(copy.db)]
				run = applyToCopy(copy.db, sql)
			}
			if (run.error !== undefined) {
				const why = `comb could not run this in the proof copy: ${run.error}`
				proofs.set(name, { cautious: [], failed: why, unproven: unprovenOf(copy), unsafe: [why] })
				/* the later files are proven on the schema this one leaves, seeded fresh (M13) */
				const after = await schemaAfter(objects, [...applied, sql], engineTables)
				if (after === undefined) {
					failed = `an earlier pending file, ${name}, could not run in the proof copy, so this one is unproven`
					continue
				}
				copy.db.close()
				objects = after
				applied = []
				copy = await copyOf(objects, { json, variant: 0 })
				continue
			}
			applied.push(sql)
			const found = compare(
				copy.db,
				new Map([...before].filter(([table]) => !copy.unproven.has(table))),
				snapshot(copy.db),
			)
			const engine = engineFindings(run.steps, run.start)
			proofs.set(name, {
				cautious: [...engine.cautious, ...found.cautious],
				unproven: unprovenOf(copy),
				unsafe: [...engine.unsafe, ...found.unsafe, ...mirrorFindings(mirrors, mirrorRows(copy.db))],
			})
		}
	} finally {
		copy.db.close()
	}
	return proofs
}

/** The tables a copy could not seed, as a proof lists them */
const unprovenOf = (copy: Copy) => [...copy.unproven].map(([table, why]) => ({ table, why }))

export { type Proof, provePending }
