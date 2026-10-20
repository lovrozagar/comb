/**
 * FTS5 objects in SQLite migrations. Atlas replays history and diffs on a dev SQLite without the
 * fts5 module, so comb keeps FTS out of what Atlas sees: it strips the FTS statements from the
 * history it replays and from the target, and writes the FTS part of each migration itself.
 *
 * An FTS group is one fts5 virtual table and the triggers that write into it. A group is written
 * again (triggers and table dropped, created from the target, rebuilt from its content table) when
 * its definition changed, or when Atlas rewrites its content table: SQLite drops a table's
 * triggers with it, and the rewrite gives its rows new rowids.
 */
import { normalizeSql, splitSqlStatements } from "./sql-scan.ts"

/* An object name, bare or in any SQLite quotes, is [`"[]?(\w+)[`"\]]? in each pattern below. They
   match normalizeSql output: comments gone, whitespace one space. */
const CREATE_FTS = /^CREATE VIRTUAL TABLE (?:IF NOT EXISTS )?[`"[]?(\w+)[`"\]]? USING fts5 ?\(.*\bcontent ?= ?'(\w+)'/i
const CREATE_FTS_BARE = /^CREATE VIRTUAL TABLE (?:IF NOT EXISTS )?[`"[]?(\w+)[`"\]]? USING fts5\b/i
const CREATE_TRIGGER = /^CREATE (?:TEMP |TEMPORARY )?TRIGGER (?:IF NOT EXISTS )?[`"[]?(\w+)[`"\]]?/i
const DROP = /^DROP (TABLE|TRIGGER) (?:IF EXISTS )?[`"[]?(\w+)[`"\]]?$/i
const REBUILD = /^INSERT INTO [`"[]?(\w+)[`"\]]? ?\(/i
const DROP_TABLE = /^DROP TABLE (?:IF EXISTS )?[`"[]?(\w+)[`"\]]?/i
const RENAME_TO = /^ALTER TABLE [`"[]?\w+[`"\]]? RENAME TO [`"[]?(\w+)[`"\]]?$/i

/** One FTS object as a migration leaves it: its normalized DDL and the group it belongs to */
type FtsObject = { group: string; kind: "table" | "trigger"; sql: string }

/** The FTS objects a sequence of migrations leaves, by name */
type FtsState = Map<string, FtsObject>

/** The FTS table a trigger writes into, among `groups`; undefined when it writes into none */
function writesInto(sql: string, groups: ReadonlySet<string>): string | undefined {
	return [...groups].find((group) => new RegExp(String.raw`\bINTO [\`"[]?${group}(?![\w$])`, "i").test(sql))
}

/** `sql` with every quoted plain name bare, so DDL that differs only in quoting compares equal */
const bare = (sql: string | undefined) => sql?.replace(/[`"[](\w+)[`"\]]/g, "$1")

type Classified = { fts: false } | { fts: true; apply: (state: FtsState) => void }

/** Whether one normalized statement is FTS DDL, and what it does to the FTS state */
function classify(sql: string, groups: Set<string>, state: FtsState): Classified {
	const table = CREATE_FTS_BARE.exec(sql)?.[1]
	if (table !== undefined) {
		groups.add(table)
		return { apply: (s) => void s.set(table, { group: table, kind: "table", sql }), fts: true }
	}
	const trigger = CREATE_TRIGGER.exec(sql)?.[1]
	const target = trigger === undefined ? undefined : writesInto(sql, groups)
	if (trigger !== undefined && target !== undefined) {
		return { apply: (s) => void s.set(trigger, { group: target, kind: "trigger", sql }), fts: true }
	}
	const dropped = DROP.exec(sql)?.[2]
	if (dropped !== undefined && (groups.has(dropped) || state.has(dropped))) {
		return { apply: (s) => void s.delete(dropped), fts: true }
	}
	const rebuilt = REBUILD.exec(sql)?.[1]
	return rebuilt !== undefined && groups.has(rebuilt) ? { apply: () => undefined, fts: true } : { fts: false }
}

type Separated = { fts: string[]; plain: string[]; state: FtsState }

/**
 * `sql`'s statements split into those Atlas may see and the FTS state they leave, continuing
 * from `state` with the FTS tables `groups` already names.
 */
function separate(sql: string, groups: Set<string>, state: FtsState = new Map()): Separated {
	const fts: string[] = []
	const plain: string[] = []
	for (const statement of splitSqlStatements(sql)) {
		const verdict = classify(normalizeSql(statement), groups, state)
		if (verdict.fts) {
			verdict.apply(state)
			fts.push(statement)
		} else {
			plain.push(statement)
		}
	}
	return { fts, plain, state }
}

/** Statements joined back into a migration file's text */
const asSql = (statements: readonly string[]): string =>
	statements.length === 0 ? "" : `${statements.join(";\n\n")};\n`

/** The content table of each FTS group in `state` */
function contentTables(state: FtsState): Map<string, string> {
	const tables = new Map<string, string>()
	for (const [name, object] of state) {
		const content = object.kind === "table" ? CREATE_FTS.exec(object.sql)?.[2] : undefined
		if (content !== undefined) tables.set(name, content)
	}
	return tables
}

/** The groups whose objects differ between `from` and `to` */
function changedGroups(from: FtsState, to: FtsState): Set<string> {
	const changed = new Set<string>()
	for (const name of new Set([...from.keys(), ...to.keys()])) {
		const before = from.get(name)
		const after = to.get(name)
		/* the name came from one of the two maps, so one of them holds it */
		if (bare(before?.sql) !== bare(after?.sql)) changed.add((before ?? (after as FtsObject)).group)
	}
	return changed
}

/** Tables a plain SQLite diff rewrites (drops, or renames a rebuilt copy onto) */
function rewrittenTables(diff: string): Set<string> {
	const tables = new Set<string>()
	for (const statement of splitSqlStatements(diff)) {
		const sql = normalizeSql(statement)
		const dropped = DROP_TABLE.exec(sql)?.[1]
		const renamed = RENAME_TO.exec(sql)?.[1]
		for (const table of [dropped, renamed]) if (table !== undefined) tables.add(table)
	}
	return tables
}

const dropRank = (object: FtsObject) => (object.kind === "trigger" ? 0 : 1)

type FtsDelta = {
	/** The FTS state the migration history leaves */
	from: FtsState
	/** The plain SQL Atlas generated for this migration, to see which tables it rewrites */
	plainDiff: string
	/** The FTS state the target declares */
	to: FtsState
	/** The target's FTS statements as written, in order (`separate(...).fts`) */
	toStatements: readonly string[]
}

/** The FTS statements a migration needs after its plain part; "" when it needs none */
function ftsDelta({ from, plainDiff, to, toStatements }: FtsDelta): string {
	const affected = changedGroups(from, to)
	const rewritten = rewrittenTables(plainDiff)
	for (const [group, table] of [...contentTables(from), ...contentTables(to)]) {
		if (rewritten.has(table)) affected.add(group)
	}
	if (affected.size === 0) return ""
	const drops = [...from]
		.filter(([, object]) => affected.has(object.group))
		/* triggers before the table they write into */
		.sort(([, a], [, b]) => dropRank(a) - dropRank(b))
		.map(([name, object]) => `DROP ${object.kind === "table" ? "TABLE" : "TRIGGER"} IF EXISTS "${name}"`)
	const creates = toStatements.filter((statement) => {
		const sql = normalizeSql(statement)
		const name = CREATE_FTS_BARE.exec(sql)?.[1] ?? CREATE_TRIGGER.exec(sql)?.[1]
		const object = name === undefined ? undefined : to.get(name)
		return object !== undefined && affected.has(object.group)
	})
	const rebuilds = [...affected]
		.filter((group) => to.get(group)?.kind === "table")
		.map((group) => `INSERT INTO "${group}"("${group}") VALUES ('rebuild')`)
	return asSql([...drops, ...creates, ...rebuilds])
}

export { asSql, ftsDelta, separate, type FtsState }
