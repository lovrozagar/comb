/**
 * What a backfill may fill, followed statement by statement: the tables a file has created and no
 * copy of existing rows has filled since, and the columns it has added. Created and added mean new:
 * a CREATE TABLE or ADD COLUMN without IF NOT EXISTS, of a name the earlier migrations do not show.
 * A schema-qualified table matches only itself, folded as SQLite folds names; Postgres's fresh tables
 * and columns are followed from its parse tree (pg-ddl.ts). The writes themselves are read from the
 * engine: SQLite's in the proof run, Postgres's parse tree in pg-tree.ts.
 */
import type { ExtractedSchema } from "../types.ts"
import { IDENT, lastPart, nameKey, QNAME, qualifiedKey, splitTopLevel } from "./sql-code.ts"

/**
 * What a backfill may fill: the tables a file has created and nothing has filled since, and the
 * columns it has added and nothing has written since; read against the earlier schema
 */
type Fresh = {
	before?: ExtractedSchema | undefined
	columns: Map<string, Set<string>>
	tables: Set<string>
}

/** A file's start: nothing created or added yet */
const freshStart = (before?: ExtractedSchema): Fresh => ({
	before,
	columns: new Map(),
	tables: new Set(),
})

// per-process-constant: a CREATE TABLE's table, composed once
const CREATE = /* @__PURE__ */ new RegExp(
	`^CREATE (?:(?:TEMP|TEMPORARY|UNLOGGED) )?TABLE (?:IF NOT EXISTS )?(${QNAME})`,
	"i",
)
// per-process-constant: the table an INSERT fills, composed once
const INSERT = /* @__PURE__ */ new RegExp(`^(?:WITH\\b.*?\\b)?INSERT (?:OR \\w+ )?INTO (${QNAME})`, "i")
// per-process-constant: an ALTER TABLE's table and its actions, composed once
const ALTER = /* @__PURE__ */ new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${QNAME})(?: \\*)? (.+)$`, "i")
// per-process-constant: an ADD COLUMN action's column
const ADD = /* @__PURE__ */ new RegExp(
	`^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(?!(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\\b)(${IDENT})`,
	"i",
)
/** `fresh` with the table a CREATE TABLE in `code` creates new: no IF NOT EXISTS, and a name the earlier migrations do not show */
function followCreate(code: string, fresh: Fresh): void {
	const created = CREATE.exec(code)?.[1]
	if (created === undefined || /\bIF NOT EXISTS\b/i.test(code)) return
	if (fresh.before?.tables.has(nameKey(created, "sqlite")) !== true) fresh.tables.add(qualifiedKey(created))
}

/** `fresh` with the columns an ALTER TABLE in `code` adds new: no IF NOT EXISTS, and none the table had */
function followAlter(code: string, fresh: Fresh): void {
	const [, table, actions] = ALTER.exec(code) ?? []
	if (table === undefined || actions === undefined) return
	const key = qualifiedKey(table)
	const had = fresh.before?.tables.get(nameKey(table, "sqlite")) ?? []
	for (const action of splitTopLevel(actions)) {
		const column = ADD.exec(action)?.[1]
		if (column === undefined || /^ADD (?:COLUMN )?IF NOT EXISTS\b/i.test(action) || had.includes(lastPart(column)))
			continue
		fresh.columns.set(key, (fresh.columns.get(key) ?? new Set()).add(lastPart(column)))
	}
}

/**
 * `fresh` after `code`: the table a CREATE TABLE creates new, or the columns an ALTER TABLE adds
 * new; a table an INSERT … SELECT fills holds rows that were there before, and is fresh no longer
 */
function followAdds(code: string, fresh: Fresh): void {
	followCreate(code, fresh)
	const filled = INSERT.exec(code)?.[1]
	if (filled !== undefined && /\bSELECT\b/i.test(code)) fresh.tables.delete(qualifiedKey(filled))
	followAlter(code, fresh)
}

export { followAdds, type Fresh, freshStart }
