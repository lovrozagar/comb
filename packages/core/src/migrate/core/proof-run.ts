/**
 * The proof run, on the SQLite family (bun:sqlite, libsql, D1): before a check or an apply, each
 * pending file runs on a private scratch copy of the target's live schema, seeded with rows that
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
import { isMirror, mirrorFindings, mirrorRows } from "./proof-mirror.ts"
import { type LocalDb, openScratch } from "../drivers/local-db.ts"
import type { Connection } from "../types.ts"
import { notEngineTables } from "./engine-tables.ts"
import { compare, type Shape } from "./proof-compare.ts"
import { type Copy, copyOf, buildCopy, creatable, jsonColumns, type LiveObject, liveObjects } from "./proof-copy.ts"
import { applyToCopy, engineFindings } from "./proof-engine.ts"
import { quote } from "./proof-seed.ts"
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

/** Every table of the copy but a mirror FTS table, each with its stored columns and rows (each value as SQLite quotes it) */
function snapshot(db: LocalDb): Map<string, Shape> {
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
	const db = await openScratch()
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

/** `work`, its refusal named for the file `name`: what the proof refuses outright, no approval overrides, so the file is named where it stops */
function named<T>(name: string, work: () => T): T {
	try {
		return work()
	} catch (error) {
		throw new Error(`${name}: ${(error as Error).message}`, { cause: error })
	}
}

/**
 * Prove each pending file, in order, on a seeded scratch copy of the database `conn` reaches;
 * returns each file's proof by name. A file the copy refuses is tried once more on a reseeded copy
 * (a seed's value can meet a file's unique index or explicit id); a file refused both ways is
 * unproven, and so unsafe. The later files are proven on the schema it leaves, seeded fresh; when
 * it fails even on a copy with no rows, they are unproven too. `live` is the schema the caller read
 * already (plan-apply.ts), which this reads otherwise. The engine's own tables are left out of every
 * read of a schema, the target's and the copy's (P4).
 */
async function provePending(
	conn: Connection,
	files: ReadonlyArray<{ name: string; sql: string }>,
	live?: readonly LiveObject[],
): Promise<Map<string, Proof>> {
	const json = jsonColumns(files)
	const engineTables = notEngineTables(conn)
	let objects = live === undefined ? creatable(await liveObjects(conn, engineTables)) : [...live]
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
			let run = named(name, () => applyToCopy(copy.db, sql))
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
