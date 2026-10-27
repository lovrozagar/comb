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
import { randomBytes } from "node:crypto"
import type { MemoryDb } from "../drivers/memory.ts"
import type { ExtractedSchema } from "../types.ts"
import { preview } from "./classify-file.ts"
import { readGuards } from "./guard-read.ts"
import { outsideReach } from "./proof-outside.ts"
import { extractSchema } from "./schema.ts"
import { type Context, type Effects, MARK, walkProgram } from "./proof-walk.ts"
import { asciiFold, codeOf } from "./sql-code.ts"
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

/** A run's probe-name prefix: a token of its own, so no temp trigger a file made can take a probe's name (M46) */
const probePrefix = (): string => `comb_probe_${randomBytes(8).toString("hex")}_`

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Main's root pages: the table each stores, an index's root its table's, and which are tables' own */
function rootsOf(db: MemoryDb): Pick<Context, "main" | "tables"> {
	const main = new Map<number, string>()
	const tables = new Set<number>()
	for (const row of db.all("SELECT type, rootpage, tbl_name FROM main.sqlite_schema WHERE rootpage > 0")) {
		main.set(Number(row["rootpage"]), asciiFold(String(row["tbl_name"])))
		if (row["type"] === "table") tables.add(Number(row["rootpage"]))
	}
	return { main, tables }
}

/**
 * One probe trigger per column of each table of `probed`: its marker shows the column is assigned. A
 * virtual table and the shadow tables that store one take no trigger and need none: a statement
 * writes a virtual table through VUpdate, and SQLite refuses to prepare one that writes a shadow
 * table itself.
 */
function placeProbes(
	db: MemoryDb,
	{ prefix, probed }: { prefix: string; probed: ReadonlySet<string> },
): Array<{ column: string; table: string }> {
	const probes: Array<{ column: string; table: string }> = []
	for (const row of db.all("PRAGMA main.table_list")) {
		/* the catalog's own name: a folded one SQLite would not find unless only ASCII letters differ */
		const table = String(row["name"])
		if (row["type"] !== "table" || !probed.has(asciiFold(table))) continue
		for (const info of db.all(`PRAGMA main.table_xinfo(${quote(table)})`)) {
			const column = String(info["name"])
			db.exec(
				`CREATE TEMP TRIGGER ${prefix}${probes.length} BEFORE UPDATE OF ${quote(column)} ON main.${quote(table)} BEGIN SELECT ${MARK + probes.length}; END`,
			)
			probes.push({ column: asciiFold(column), table: asciiFold(table) })
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
	/* an FTS sync trigger is read from its body and the external-content FTS tables before it: the
	   rest of the schema, read again for every statement, cost a schema of thousands of tables seconds */
	const ftsAndTriggers = db
		.all(
			"SELECT sql FROM main.sqlite_schema WHERE sql IS NOT NULL AND (type = 'trigger' OR sql LIKE 'CREATE VIRTUAL TABLE%') ORDER BY rowid",
		)
		.map((row) => `${String(row["sql"])};`)
		.join("\n")
	const synced = new Set(
		extractSchema(ftsAndTriggers)
			.triggers.filter((trigger) => trigger.ftsSync)
			.map((trigger) => trigger.name),
	)
	const out = new Set<string>()
	for (const schema of ["main", "temp"]) {
		for (const row of db.all(`SELECT name, tbl_name FROM ${schema}.sqlite_schema WHERE type = 'trigger'`)) {
			const name = asciiFold(String(row["name"]))
			if (existing.has(asciiFold(String(row["tbl_name"]))) && !synced.has(name)) out.add(name)
		}
	}
	return out
}

/* OPFLAG_P2ISREG (0x10): an OpenWrite whose P2 is the register that holds its root page */
const P2_IS_REGISTER = 16

/**
 * The tables of main a program opens for writing, its triggers' and foreign-key actions'
 * subprograms included, each by the table a root page stores, an index's its table's. The schema
 * table, another database's cursor and a btree the program itself creates (CREATE INDEX, CREATE
 * TABLE AS) hold no existing row. Undefined when a root page is not one of main's, or sits in a
 * register no CreateBtree filled: then every existing table takes probes.
 */
function writtenTables(
	ops: ReadonlyArray<Record<string, unknown>>,
	main: ReadonlyMap<number, string>,
): Set<string> | undefined {
	const out = new Set<string>()
	const created = new Set<number>()
	for (const op of ops) {
		if (op["opcode"] === "CreateBtree") created.add(Number(op["p2"]))
		if (op["opcode"] !== "OpenWrite" || Number(op["p3"]) !== 0) continue
		const root = Number(op["p2"])
		if (Math.floor(Number(op["p5"]) / P2_IS_REGISTER) % 2 === 1) {
			if (!created.has(root)) return undefined
			continue
		}
		const table = root === 1 ? null : main.get(root)
		if (table === undefined) return undefined
		if (table !== null) out.add(table)
	}
	return out
}

/**
 * What `sql`, one statement, does to `existing` on `db`, read before it runs; why, when SQLite
 * cannot prepare it. A first `EXPLAIN` without probes names the tables the statement writes, and
 * only those of `existing` take probes for the second: a probe's body opens no cursor, so a table
 * the first does not write cannot be assigned, and a probe on every column of a schema of
 * thousands cost seconds a statement.
 */
function explainStatement(db: MemoryDb, sql: string, existing: ReadonlySet<string>): Effects | string {
	let ops: Array<Record<string, unknown>>
	try {
		ops = db.all(`EXPLAIN ${sql}`)
	} catch (error) {
		return (error as Error).message
	}
	/* the copy runs what it proves, so this is refused before it runs, and no approval overrides it (M40) */
	const outside = outsideReach(ops)
	if (outside !== undefined) {
		throw new Error(
			`${preview(sql)}: comb never runs ${outside} in a migration: it reaches outside the database the migration applies to, and D1 refuses it`,
		)
	}
	const roots = rootsOf(db)
	const written = writtenTables(ops, roots.main)
	const prefix = probePrefix()
	const probes = placeProbes(db, {
		prefix,
		probed: written === undefined ? existing : new Set([...written].filter((t) => existing.has(t))),
	})
	if (probes.length > 0) {
		try {
			ops = db.all(`EXPLAIN ${sql}`)
		} finally {
			for (let i = 0; i < probes.length; i++) db.exec(`DROP TRIGGER temp.${prefix}${i}`)
		}
	}
	return walkProgram(ops, { existing, probes, watched: watching(db, existing), ...roots })
}

/** The temp objects that answer for an existing table's name */
function shadowsOf(db: MemoryDb, existing: ReadonlySet<string>): Array<{ name: string; type: string }> {
	return db
		.all("SELECT name, type FROM temp.sqlite_schema WHERE type IN ('table', 'view')")
		.map((row) => ({ name: asciiFold(String(row["name"])), type: String(row["type"]) }))
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
			asciiFold(name),
			new Set(db.all(`PRAGMA main.table_xinfo(${quote(name)})`).map((c) => asciiFold(String(c["name"])))),
		)
	}
	return out
}

/**
 * The statements of `statements` the classifier alone rates: a DROP TABLE, which with foreign keys
 * on SQLite codes as a delete of the table's rows and of what cascades from them (the classifier
 * rates a drop, a rebuild and an FTS index's drop, and the row compare checks what they leave), and
 * each statement of comb's guard around a rebuild, exactly as comb wrote it, which empties and
 * refills what the drop reaches (rebuild-guard.ts). Only their deletes are the classifier's: a
 * trigger one of them fires is still the engine's finding.
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
	for (const { effects, statement } of steps.filter((step) => step.classified)) {
		const at = preview(statement)
		for (const trigger of effects.triggers) unsafe.push(`${at}: fires trigger ${trigger} (its WHEN is not evaluated)`)
	}
	for (const { effects, shadows, statement } of steps.filter((step) => !step.classified)) {
		const at = preview(statement)
		for (const [table, columns] of effects.assigns) {
			const listed = [...columns].join(", ")
			const old = [...columns].some((column) => start.get(table)?.has(column) === true)
			/* a write that also deletes rows of the table, as a REPLACE does, is no backfill of it (M41) */
			if (old) unsafe.push(`${at}: updates existing rows of ${table} (${listed})`)
			else if (effects.triggers.length === 0 && !effects.deletes.has(table))
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

export { applyToCopy, engineFindings, writtenTables }
