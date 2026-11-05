/**
 * The proof run, on the SQLite family (bun:sqlite, libsql, D1): before a check or an apply, each
 * pending file runs on a private scratch copy of what the pending files can observe of the target's
 * live schema (proof-scope.ts), seeded with rows that show any change (proof-seed.ts), and every
 * table that was there before is compared, row for row,
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
import { type LocalDb, openScratch, type ScratchEngine } from "../drivers/local-db.ts"
import type { Connection } from "../types.ts"
import { notEngineTables } from "./engine-tables.ts"
import { compare, type Shape } from "./proof-compare.ts"
import { type Copy, copyOf, buildCopy, creatable, jsonColumns, type LiveObject, liveObjects } from "./proof-copy.ts"
import { applyToCopy, engineFindings } from "./proof-engine.ts"
import { quote } from "./proof-seed.ts"
import { observable } from "./proof-scope.ts"
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
	/* main's own: a temp table of the same name would answer for a bare name */
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
	for (const { name } of live.filter((object) => !isMirror(object)))
		out.set(
			asciiFold(name),
			named(name, () => shapeOf(db, name)),
		)
	return out
}

/** Table `name`'s stored columns and rows; throws what SQLite answers when it cannot read them */
function shapeOf(db: LocalDb, name: string): Shape {
	const info = db.all(`PRAGMA main.table_xinfo(${quote(name)})`).filter((row) => row["hidden"] === 0)
	const columns = info.map((row) => String(row["name"]))
	const rows = db
		.all(
			`SELECT ${columns.map((column) => `quote(${quote(column)}) AS ${quote(column)}`).join(", ")} FROM main.${quote(name)}`,
		)
		.map((row) => columns.map((column) => String(row[column])))
	return {
		columns,
		defaults: new Map(
			info.map((row) => [String(row["name"]), row["dflt_value"] === null ? null : String(row["dflt_value"])]),
		),
		nullable: new Set(info.filter((row) => row["notnull"] === 0 && row["pk"] === 0).map((row) => String(row["name"]))),
		rows,
	}
}

/** What a copy of `objects` is made on: the engine, the pending files, and the columns they read as JSON */
type Making = { engine: ScratchEngine; files: ReadonlyArray<{ sql: string }>; json: ReadonlySet<string> }

/**
 * A copy of `objects` seeded as `variant`, holding only what the pending files can observe, the D1 proof's
 * closure (proof-scope.ts): what a file names, writes through a trigger or a key, or reads
 * through a view. Every pending file's names count, so one copy serves them all in order
 */
async function scopedCopy(
	objects: readonly LiveObject[],
	variant: number,
	{ engine, files, json }: Making,
): Promise<Copy> {
	const scope = observable(objects, files)
	return await copyOf(scope.objects, { json, rows: scope.seeded, variant }, engine)
}

/**
 * A fresh copy, reseeded with values the first seed never held, the files that applied before
 * replayed on it; undefined, and closed, when one of them no longer applies
 */
async function reseeded(
	objects: readonly LiveObject[],
	applied: readonly string[],
	making: Making,
): Promise<Copy | undefined> {
	const copy = await scopedCopy(objects, 1, making)
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
	{ engine, engineTables }: { engine: ScratchEngine; engineTables: string },
): Promise<LiveObject[] | undefined> {
	const db = await openScratch(engine)
	try {
		buildCopy(db, objects, undefined)
		if (!files.every((sql) => applyToCopy(db, sql).error === undefined)) return undefined
		return creatable(
			db
				.all(
					`SELECT type, name, sql, tbl_name FROM main.sqlite_master WHERE sql IS NOT NULL${engineTables} ORDER BY rowid`,
				)
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
 * Each of `files` after a turn of the event loop, where a SIGINT or SIGTERM's handler runs: a file's
 * proof runs synchronously, so without one a Ctrl-C would wait out the whole proof
 */
async function* turns<T>(files: readonly T[]): AsyncGenerator<T> {
	for (const file of files) {
		await new Promise((resolve) => setImmediate(resolve))
		yield file
	}
}

/**
 * The copy's tables after a file, or why SQLite cannot read one: a file can leave a table no read
 * opens, as an fts5vocab table over a dropped fts table, which fails on the live database at its
 * first read
 */
function snapshotAfter(db: Copy["db"]): Map<string, Shape> | string {
	try {
		return snapshot(db)
	} catch (error) {
		return (error as Error).message
	}
}

/** The proof of a file that applied as `run`, from the copy's tables and mirrored rows before it and its tables after */
function appliedProof(
	copy: Copy,
	run: ReturnType<typeof applyToCopy>,
	{
		after,
		before,
		mirrors,
	}: { after: Map<string, Shape>; before: Map<string, Shape>; mirrors: ReturnType<typeof mirrorRows> },
): Proof {
	const found = compare(copy.db, new Map([...before].filter(([table]) => !copy.unproven.has(table))), after)
	const steps = engineFindings(run.steps, run.start)
	return {
		cautious: [...steps.cautious, ...found.cautious],
		unproven: unprovenOf(copy),
		unsafe: [...steps.unsafe, ...found.unsafe, ...mirrorFindings(mirrors, mirrorRows(copy.db))],
	}
}

/** A file's proof that failed for `why`, which is unsafe */
const failedProof = (copy: Copy, why: string): Proof => ({
	cautious: [],
	failed: why,
	unproven: unprovenOf(copy),
	unsafe: [why],
})

/**
 * Prove each pending file, in order, on a seeded scratch copy of the database `conn` reaches;
 * returns each file's proof by name. A file the copy refuses is tried once more on a reseeded copy
 * (a seed's value can meet a file's unique index or explicit id); a file refused both ways is
 * unproven, and so unsafe. The later files are proven on the schema it leaves, seeded fresh; when
 * it fails even on a copy with no rows, they are unproven too. `live` is the schema the caller read
 * already (plan-apply.ts), which this reads otherwise. The engine's own tables are left out of every
 * read of a schema, the target's and the copy's.
 */
async function provePending(
	conn: Connection,
	files: ReadonlyArray<{ name: string; sql: string }>,
	{ engine = "runtime", live }: { engine?: ScratchEngine | undefined; live?: readonly LiveObject[] | undefined } = {},
): Promise<Map<string, Proof>> {
	const engineTables = notEngineTables(conn)
	let objects = live === undefined ? creatable(await liveObjects(conn, engineTables)) : [...live]
	const making: Making = { engine, files, json: jsonColumns(files) }
	let copy = await scopedCopy(objects, 0, making)
	const proofs = new Map<string, Proof>()
	let applied: string[] = []
	let failed: string | undefined
	try {
		for await (const { name, sql } of turns(files)) {
			if (failed !== undefined) {
				proofs.set(name, failedProof(copy, failed))
				continue
			}
			let [before, mirrors] = [snapshot(copy.db), mirrorRows(copy.db)]
			let run = named(name, () => applyToCopy(copy.db, sql))
			const retry = run.error === undefined ? undefined : await reseeded(objects, applied, making)
			if (retry !== undefined) {
				copy.db.close()
				copy = retry
				;[before, mirrors] = [snapshot(copy.db), mirrorRows(copy.db)]
				run = applyToCopy(copy.db, sql)
			}
			if (run.error !== undefined) {
				proofs.set(
					name,
					failedProof(copy, `comb could not run this in the proof copy on ${copy.db.engine}: ${run.error}`),
				)
				/* the later files are proven on the schema this one leaves, seeded fresh */
				const after = await schemaAfter(objects, [...applied, sql], { engine, engineTables })
				if (after === undefined) {
					failed = `an earlier pending file, ${name}, could not run in the proof copy, so this one is unproven`
					continue
				}
				copy.db.close()
				;[objects, applied] = [after, []]
				copy = await scopedCopy(objects, 0, making)
				continue
			}
			applied.push(sql)
			const after = snapshotAfter(copy.db)
			if (typeof after === "string") {
				proofs.set(
					name,
					failedProof(copy, `this applies in the proof copy on ${copy.db.engine}, then SQLite cannot read ${after}`),
				)
				failed = `an earlier pending file, ${name}, left a table SQLite cannot read, so this one is unproven`
				continue
			}
			proofs.set(name, appliedProof(copy, run, { after, before, mirrors }))
		}
	} finally {
		copy.db.close()
	}
	return proofs
}

/** The tables a copy could not seed, as a proof lists them */
const unprovenOf = (copy: Copy) => [...copy.unproven].map(([table, why]) => ({ table, why }))

export { type Proof, provePending }
