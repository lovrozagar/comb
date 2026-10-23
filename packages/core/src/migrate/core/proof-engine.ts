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
import { type Context, type Effects, MARK, walkProgram } from "./proof-walk.ts"
import { codeOf } from "./sql-code.ts"
import { splitSqlStatements } from "./sql-scan.ts"

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

const PROBE = "comb_probe_"

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Main's root pages: the table each stores, an index's root its table's, and which are tables' own */
function rootsOf(db: MemoryDb): Pick<Context, "main" | "tables"> {
	const main = new Map<number, string>()
	const tables = new Set<number>()
	for (const row of db.all("SELECT type, rootpage, tbl_name FROM main.sqlite_schema WHERE rootpage > 0")) {
		main.set(Number(row["rootpage"]), String(row["tbl_name"]).toLowerCase())
		if (row["type"] === "table") tables.add(Number(row["rootpage"]))
	}
	return { main, tables }
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
	return walkProgram(ops, { existing, probes, watched: watching(db, existing), ...rootsOf(db) })
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
		for (const table of effects.drops) unsafe.push(`${at}: drops ${table} outside a DROP TABLE`)
		for (const unread of effects.unread) unsafe.push(`${at}: does what comb cannot read to ${unread}`)
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
