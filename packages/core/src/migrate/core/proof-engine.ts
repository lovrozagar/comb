/**
 * What each statement of a pending file does to the tables that were there before the file, read
 * from SQLite itself on the proof's in-memory copy (proof-run.ts), never from the statement's text:
 * `EXPLAIN` lists the cursors it opens for writing, by root page, and the opcodes it runs on them; a
 * temporary `BEFORE UPDATE OF` trigger per existing column, whose marker shows in `EXPLAIN` when the
 * statement assigns that column, names the columns an update writes. Each trigger the statement can
 * fire is compiled into a subprogram that `EXPLAIN` lists after it, headed `-- TRIGGER <name>`, with
 * its own cursors. Then the statement runs, and a temp object that took an existing table's name is
 * a shadow. The probes exist only on the copy, between the `EXPLAIN` and the run.
 */
import type { MemoryDb } from "../drivers/memory.ts"
import type { ExtractedSchema } from "../types.ts"
import { preview } from "./classify-file.ts"
import { readGuards } from "./rebuild-guard.ts"
import { extractSchema } from "./schema.ts"
import { codeOf } from "./sql-code.ts"
import { splitSqlStatements } from "./sql-scan.ts"

/** What a statement does to existing tables, each table and column by its lower-case name */
type Effects = {
	/** the columns an update assigns, by table */
	assigns: Map<string, Set<string>>
	/** the tables whose existing rows it deletes, an update's own rewrite of a row aside */
	deletes: Set<string>
	/**
	 * the triggers on existing tables it can fire, directly or through another trigger, comb's FTS
	 * sync triggers aside; a trigger's WHEN is not evaluated
	 */
	triggers: string[]
	/**
	 * whether it updates, deletes or replaces rows of a virtual table itself, not through a trigger:
	 * SQLite codes an insert's VUpdate with P1 1, an update's and a delete's with 0, and P5 is the
	 * insert's conflict resolution, 5 for REPLACE
	 */
	virtual: boolean
}

/**
 * What one statement of a file did, read before it ran, and the temp objects that shadow a table
 * after it; `classified` when the classifier alone rates it
 */
type Step = {
	classified: boolean
	effects: Effects
	shadows: Array<{ name: string; type: string }>
	statement: string
}

/** What the walk over one statement's program knows: the tables, the probes and the triggers that count */
type Context = {
	existing: ReadonlySet<string>
	main: ReadonlyMap<number, string>
	probes: ReadonlyArray<{ column: string; table: string }>
	watched: ReadonlySet<string>
}

/** Where the walk is: the program's cursors open for writing, by number, and the trigger it is in */
type Walk = { cursors: Map<number, string>; effects: Effects; fired: Set<string>; trigger?: string }

/* the marker a probe trigger selects: probe i selects MARK + i */
const MARK = 7_770_000
const PROBE = "comb_probe_"

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/** The tables of main by root page, each name lower-cased */
function roots(db: MemoryDb): Map<number, string> {
	const out = new Map<number, string>()
	for (const row of db.all("SELECT rootpage, name FROM main.sqlite_schema WHERE rootpage > 0"))
		out.set(Number(row["rootpage"]), String(row["name"]).toLowerCase())
	return out
}

/**
 * One probe trigger per column of each existing table: its marker shows the column is assigned. A
 * virtual table and the shadow tables that store one take no trigger and need none: a statement
 * writes a virtual table through VUpdate, and SQLite refuses to prepare one that writes a shadow
 * table itself.
 */
function placeProbes(db: MemoryDb, existing: ReadonlySet<string>): Array<{ column: string; table: string }> {
	const probes: Array<{ column: string; table: string }> = []
	for (const row of db.all("PRAGMA main.table_list")) {
		const table = String(row["name"]).toLowerCase()
		if (row["type"] !== "table" || !existing.has(table)) continue
		for (const info of db.all(`PRAGMA main.table_xinfo(${quote(table)})`)) {
			const column = String(info["name"])
			db.exec(
				`CREATE TEMP TRIGGER ${PROBE}${probes.length} BEFORE UPDATE OF ${quote(column)} ON main.${quote(table)} BEGIN SELECT ${MARK + probes.length}; END`,
			)
			probes.push({ column: column.toLowerCase(), table })
		}
	}
	return probes
}

/** The schema main holds now, read the way the classifier reads a history */
function schemaOf(db: MemoryDb): ExtractedSchema {
	return extractSchema(
		db
			.all("SELECT sql FROM main.sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid")
			.map((row) => `${String(row["sql"])};`)
			.join("\n"),
	)
}

/**
 * The triggers whose firing makes a write unsafe, by lower-case name: those on existing tables,
 * comb's FTS sync triggers aside, main's and temp's alike
 */
function watching(db: MemoryDb, existing: ReadonlySet<string>): Set<string> {
	const synced = new Set(
		schemaOf(db)
			.triggers.filter((trigger) => trigger.ftsSync)
			.map((trigger) => trigger.name),
	)
	const out = new Set<string>()
	for (const schema of ["main", "temp"]) {
		for (const row of db.all(`SELECT name, tbl_name FROM ${schema}.sqlite_schema WHERE type = 'trigger'`)) {
			const name = String(row["name"]).toLowerCase()
			if (existing.has(String(row["tbl_name"]).toLowerCase()) && !synced.has(name)) out.add(name)
		}
	}
	return out
}

/** A cursor opened for writing: it writes an existing table when its root page is one of main's */
function openWrite(op: Record<string, unknown>, walk: Walk, ctx: Context): void {
	const table = Number(op["p3"]) === 0 ? ctx.main.get(Number(op["p2"])) : undefined
	if (table !== undefined && ctx.existing.has(table)) walk.cursors.set(Number(op["p1"]), table)
	else walk.cursors.delete(Number(op["p1"]))
}

/** A probe's marker: the statement assigns that probe's column */
function assign(marker: number, walk: Walk, ctx: Context): void {
	const probe = ctx.probes[marker - MARK]
	if (marker < MARK || probe === undefined) return
	const columns = walk.effects.assigns.get(probe.table) ?? new Set<string>()
	walk.effects.assigns.set(probe.table, columns.add(probe.column))
}

/** One opcode of the program after its first: the main program's, or a trigger's after its `Init` at address 0 */
function visit(op: Record<string, unknown>, walk: Walk, ctx: Context): void {
	const opcode = String(op["opcode"])
	const p1 = Number(op["p1"])
	if (opcode === "Init" && Number(op["addr"]) === 0) {
		walk.trigger = String(op["p4"])
			.replace(/^-- TRIGGER /, "")
			.toLowerCase()
		if (ctx.watched.has(walk.trigger)) walk.fired.add(walk.trigger)
		/* a subprogram numbers its cursors from 0 again */
		walk.cursors = new Map()
	} else if (opcode === "OpenWrite") openWrite(op, walk, ctx)
	else if (opcode === "Delete") {
		const table = walk.cursors.get(p1)
		if (table !== undefined) walk.effects.deletes.add(table)
	} else if (opcode === "VUpdate") {
		if (walk.trigger === undefined && (p1 === 0 || Number(op["p5"]) === 5)) walk.effects.virtual = true
	} else if (opcode === "Integer") assign(p1, walk, ctx)
}

/**
 * What `sql`, one statement, does to `existing` on `db`, read before it runs; why, when SQLite
 * cannot prepare it
 */
function explainStatement(db: MemoryDb, sql: string, existing: ReadonlySet<string>): Effects | string {
	const probes = placeProbes(db, existing)
	let ops: Array<Record<string, unknown>>
	try {
		ops = db.all(`EXPLAIN ${sql}`)
	} catch (error) {
		return (error as Error).message
	} finally {
		for (let i = 0; i < probes.length; i++) db.exec(`DROP TRIGGER temp.${PROBE}${i}`)
	}
	const ctx: Context = { existing, main: roots(db), probes, watched: watching(db, existing) }
	const walk: Walk = {
		cursors: new Map(),
		effects: { assigns: new Map(), deletes: new Set(), triggers: [], virtual: false },
		fired: new Set(),
	}
	/* the main program's own Init comes first */
	for (const op of ops.slice(1)) visit(op, walk, ctx)
	const { effects } = walk
	/* an update rewrites the rows it assigns: their Delete is no deletion of a row */
	for (const table of effects.assigns.keys()) effects.deletes.delete(table)
	effects.triggers = [...walk.fired].toSorted()
	return effects
}

/** The temp objects that answer for an existing table's name */
function shadowsOf(db: MemoryDb, existing: ReadonlySet<string>): Array<{ name: string; type: string }> {
	return db
		.all("SELECT name, type FROM temp.sqlite_schema WHERE type IN ('table', 'view')")
		.map((row) => ({ name: String(row["name"]).toLowerCase(), type: String(row["type"]) }))
		.filter(({ name }) => existing.has(name))
}

/** The existing tables of the copy, by lower-case name, each with its columns */
function tablesOf(db: MemoryDb): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>()
	for (const row of db.all(
		"SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
	)) {
		const name = String(row["name"])
		out.set(
			name.toLowerCase(),
			new Set(db.all(`PRAGMA main.table_xinfo(${quote(name)})`).map((c) => String(c["name"]).toLowerCase())),
		)
	}
	return out
}

/**
 * The statements of `statements` the classifier alone rates: a DROP TABLE, which with foreign keys
 * on SQLite codes as a delete of the table's rows and of what cascades from them (the classifier
 * rates a drop, a rebuild and an FTS index's drop, and the row compare checks what they leave), and
 * each statement of comb's guard around a rebuild, exactly as comb wrote it, which empties and
 * refills what the drop reaches (rebuild-guard.ts)
 */
function classifiedOf(statements: readonly string[], before: ExtractedSchema): Set<number> {
	const codes = statements.map((statement) => codeOf(statement, "sqlite"))
	const out = readGuards(statements, codes, before).guarded
	for (const [i, code] of codes.entries()) if (/^DROP TABLE\b/i.test(code)) out.add(i)
	return out
}

/**
 * Apply one file to the copy as the target would, foreign keys on and the file in one transaction,
 * one statement at a time (a multi-statement exec under Bun skips a failing statement but the last,
 * M9): each statement's effects on the tables there before the file are read before it runs.
 * Returns them, with the columns those tables had, or why a statement could not prepare or run.
 */
function applyToCopy(db: MemoryDb, sql: string): { error?: string; start: Map<string, Set<string>>; steps: Step[] } {
	const start = tablesOf(db)
	const existing = new Set(start.keys())
	const statements = splitSqlStatements(sql)
	const classified = classifiedOf(statements, schemaOf(db))
	const steps: Step[] = []
	db.exec("PRAGMA foreign_keys = ON")
	db.exec("BEGIN")
	for (const [i, statement] of statements.entries()) {
		const effects = explainStatement(db, statement, existing)
		let error = typeof effects === "string" ? effects : undefined
		if (error === undefined) {
			try {
				db.exec(statement)
			} catch (thrown) {
				// reason: a statement the copy refuses is the file's failure, returned with the statement
				error = (thrown as Error).message
			}
		}
		if (error !== undefined) {
			db.exec("ROLLBACK")
			return { error: `${preview(statement)}: ${error}`, start, steps }
		}
		steps.push({
			classified: classified.has(i),
			effects: effects as Effects,
			shadows: shadowsOf(db, existing),
			statement,
		})
	}
	db.exec("COMMIT")
	return { start, steps }
}

/**
 * The ratings a file's effects give: unsafe for what changes or loses rows that were there before
 * it, cautious for a backfill of only the columns it added, with no trigger fired. A trigger's WHEN
 * is not evaluated: a trigger SQLite compiles for the write counts as fired.
 */
function engineFindings(
	steps: readonly Step[],
	start: ReadonlyMap<string, Set<string>>,
): { cautious: string[]; unsafe: string[] } {
	const unsafe: string[] = []
	const cautious: string[] = []
	const shadowed = new Set<string>()
	for (const { effects, shadows, statement } of steps.filter((step) => !step.classified)) {
		const at = preview(statement)
		for (const [table, columns] of effects.assigns) {
			const listed = [...columns].join(", ")
			const old = [...columns].some((column) => start.get(table)?.has(column) === true)
			if (old) unsafe.push(`${at}: updates existing rows of ${table} (${listed})`)
			else if (effects.triggers.length === 0)
				cautious.push(`${at}: backfills ${table} (${listed}), columns this file added`)
		}
		for (const table of effects.deletes) unsafe.push(`${at}: deletes existing rows of ${table}`)
		for (const trigger of effects.triggers) unsafe.push(`${at}: fires trigger ${trigger} (its WHEN is not evaluated)`)
		if (effects.virtual) unsafe.push(`${at}: writes over rows of a virtual table`)
		for (const { name, type } of shadows.filter((shadow) => !shadowed.has(shadow.name))) {
			shadowed.add(name)
			unsafe.push(`${at}: a temp ${type} shadows ${name} for the rest of the file`)
		}
	}
	return { cautious, unsafe }
}

export { applyToCopy, engineFindings }
