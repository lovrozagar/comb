/**
 * The walk over one statement's program, as `EXPLAIN` lists it (proof-engine.ts): what it does to
 * the tables that were there before the file, read default-deny. A cursor open for writing on an
 * existing table, or on one of its indexes, may read, seek and add a row; a Delete or an IdxDelete
 * deletes one, and any other opcode on it is one comb cannot read, so unsafe. Of the opcodes that
 * name a root page, a Clear of a table's own root empties it (SQLite's truncation of a DELETE
 * without a WHERE), and a Destroy or DropTable of an existing table drops it.
 */

import { KEEPS, NOT_CURSOR, OPENS } from "./proof-opcodes.ts"
import { asciiFold } from "./sql-code.ts"

/** What a statement does to existing tables, each table and column by its lower-case name */
type Effects = {
	/** the columns an update assigns, by table */
	assigns: Map<string, Set<string>>
	/** the tables whose existing rows it deletes, an update's own rewrite of a row aside */
	deletes: Set<string>
	/** the existing tables it drops */
	drops: Set<string>
	/**
	 * the triggers on existing tables it can fire, directly or through another trigger, comb's FTS
	 * sync triggers aside; a trigger's WHEN is not evaluated
	 */
	triggers: string[]
	/** what it does to an existing table that comb cannot read: the table and the opcode */
	unread: Set<string>
	/**
	 * whether it updates, deletes or replaces rows of a virtual table itself, not through a trigger:
	 * SQLite codes an insert's VUpdate with P1 1, an update's and a delete's with 0, and P5 is the
	 * insert's conflict resolution, 5 for REPLACE
	 */
	virtual: boolean
}

/** What the walk knows: the existing tables, main's roots, the probes and the triggers that count */
type Context = {
	existing: ReadonlySet<string>
	/** the table each root page of main stores, an index's root its table's */
	main: ReadonlyMap<number, string>
	probes: ReadonlyArray<{ column: string; table: string }>
	/** the root pages of main's tables, not their indexes */
	tables: ReadonlySet<number>
	watched: ReadonlySet<string>
}

/**
 * Where the walk is: the cursors open for writing on existing tables, by number, the trigger it is
 * in, and the tables a Delete touched (an update's own rewrite nets out) apart from those emptied
 */
type Walk = {
	cursors: Map<number, string>
	effects: Effects
	emptied: Set<string>
	fired: Set<string>
	trigger?: string
}

/* the marker a probe trigger selects: probe i selects MARK + i */
const MARK = 7_770_000

/** An opcode on a root page of main: the existing table it stores, if any */
function rootOf(root: unknown, db: unknown, ctx: Context): string | undefined {
	const table = Number(db) === 0 ? ctx.main.get(Number(root)) : undefined
	return table !== undefined && ctx.existing.has(table) ? table : undefined
}

/** A probe's marker: the statement assigns that probe's column */
function assign(marker: number, walk: Walk, ctx: Context): void {
	const probe = ctx.probes[marker - MARK]
	if (marker < MARK || probe === undefined) return
	const columns = walk.effects.assigns.get(probe.table) ?? new Set<string>()
	walk.effects.assigns.set(probe.table, columns.add(probe.column))
}

/** An opcode whose P1 is no cursor: a probe's marker, a virtual table's write, or a root page's end */
function notCursor(op: Record<string, unknown>, walk: Walk, ctx: Context): void {
	const opcode = String(op["opcode"])
	const p1 = Number(op["p1"])
	const { effects } = walk
	if (opcode === "Integer") assign(p1, walk, ctx)
	else if (opcode === "VUpdate") {
		if (walk.trigger === undefined && (p1 === 0 || Number(op["p5"]) === 5)) effects.virtual = true
	} else if (opcode === "Clear") {
		/* a REINDEX clears an index's root before it fills it again: only a table's own root holds rows */
		const table = ctx.tables.has(p1) ? rootOf(op["p1"], op["p2"], ctx) : undefined
		if (table !== undefined) walk.emptied.add(table)
	} else if (opcode === "Destroy") {
		const table = ctx.tables.has(p1) ? rootOf(op["p1"], op["p3"], ctx) : undefined
		if (table !== undefined) effects.drops.add(table)
	} else if (opcode === "DropTable") {
		const table = asciiFold(String(op["p4"]))
		if (p1 === 0 && ctx.existing.has(table)) effects.drops.add(table)
	}
}

/** One opcode of the program after its first: the main program's, or a trigger's after its `Init` at address 0 */
function visit(op: Record<string, unknown>, walk: Walk, ctx: Context): void {
	const opcode = String(op["opcode"])
	const p1 = Number(op["p1"])
	if (opcode === "Init" && Number(op["addr"]) === 0) {
		walk.trigger = asciiFold(String(op["p4"]).replace(/^-- TRIGGER /, ""))
		if (ctx.watched.has(walk.trigger)) walk.fired.add(walk.trigger)
		/* a subprogram numbers its cursors from 0 again */
		walk.cursors = new Map()
		return
	}
	if (OPENS.has(opcode)) {
		const table = opcode === "OpenWrite" ? rootOf(op["p2"], op["p3"], ctx) : undefined
		if (table === undefined) walk.cursors.delete(p1)
		else walk.cursors.set(p1, table)
		return
	}
	if (NOT_CURSOR.has(opcode)) return notCursor(op, walk, ctx)
	const table = walk.cursors.get(p1)
	if (table === undefined || KEEPS.has(opcode)) return
	if (opcode === "Delete" || opcode === "IdxDelete") walk.effects.deletes.add(table)
	else walk.effects.unread.add(`${table} (${opcode})`)
}

/** What `ops`, one statement's program, does to the existing tables */
function walkProgram(ops: ReadonlyArray<Record<string, unknown>>, ctx: Context): Effects {
	const walk: Walk = {
		cursors: new Map(),
		effects: {
			assigns: new Map(),
			deletes: new Set(),
			drops: new Set(),
			triggers: [],
			unread: new Set(),
			virtual: false,
		},
		emptied: new Set(),
		fired: new Set(),
	}
	/* the main program's own Init comes first */
	for (const op of ops.slice(1)) visit(op, walk, ctx)
	const { effects } = walk
	/* an update rewrites the rows it assigns: their Delete is no deletion of a row; a Clear is */
	for (const table of effects.assigns.keys()) effects.deletes.delete(table)
	for (const table of walk.emptied) effects.deletes.add(table)
	effects.triggers = [...walk.fired].toSorted()
	return effects
}

export { type Context, type Effects, MARK, walkProgram }
