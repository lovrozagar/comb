/**
 * The write rules of the destructive-change gate. A DELETE, UPDATE, MERGE or upsert is read at
 * every depth, a CTE, a subquery or a rule's action included. Unsafe means it may destroy existing
 * values: every DELETE, whatever its WHERE (no reading of a WHERE proves it spares a row), every
 * REPLACE, a MERGE that updates or deletes, and every UPDATE or upsert but a backfill, which is
 * cautious: one into a table the same file created earlier, which had no rows when the file
 * began, or one that sets only columns the same file added and nothing has written since.
 */
import type { Finding } from "./classify-alter.ts"
import { IDENT, lastPart, QNAME, splitTopLevel, topLevel } from "./sql-code.ts"

/** What a backfill may fill: the tables a file has created, and the columns it has added and nothing has written since */
type Fresh = { columns: Map<string, Set<string>>; tables: Set<string> }

/** A file's start: nothing created or added yet */
const freshStart = (): Fresh => ({ columns: new Map(), tables: new Set() })

const QUOTED_NAME = /"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g
const DELETE = /^(?:WITH\b.*?\b)?DELETE\b/i
const REPLACE = /^(?:WITH\b.*?\b)?(?:REPLACE|INSERT OR REPLACE|UPDATE OR REPLACE)\b/i
// per-process-constant: an UPDATE's table and what follows its SET, composed once
const UPDATE = /* @__PURE__ */ new RegExp(
	`^(?:WITH\\b.*?\\b)?UPDATE (?:OR \\w+ )?(?:ONLY )?(${QNAME})(?: \\*)?(?: (?:AS )?${IDENT})? SET (.*)$`,
	"id",
)
// per-process-constant: an upsert's table and what follows its DO UPDATE SET, composed once
const UPSERT = /* @__PURE__ */ new RegExp(
	`^(?:WITH\\b.*?\\b)?INSERT (?:OR \\w+ )?INTO (${QNAME})\\b.*?\\bON CONFLICT\\b.*?\\bDO UPDATE SET (.*)$`,
	"id",
)
// per-process-constant: a CREATE TABLE's table, composed once
const CREATE = /* @__PURE__ */ new RegExp(
	`^CREATE (?:(?:TEMP|TEMPORARY|UNLOGGED) )?TABLE (?:IF NOT EXISTS )?(${QNAME})`,
	"i",
)
// per-process-constant: an ALTER TABLE's table and its actions, composed once
const ALTER = /* @__PURE__ */ new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${QNAME})(?: \\*)? (.+)$`, "i")
// per-process-constant: an ADD COLUMN action's column
const ADD = /* @__PURE__ */ new RegExp(
	`^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(?!(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\\b)(${IDENT})`,
	"i",
)
// per-process-constant: one assignment's column, or a parenthesized list of them
const ASSIGNED = /* @__PURE__ */ new RegExp(`^(?:\\(([^)]*)\\)|(${QNAME})) ?=`)

/** The columns a SET list assigns */
function assigned(list: string): string[] {
	return splitTopLevel(list).flatMap((assignment) => {
		const [, many, one] = ASSIGNED.exec(assignment) ?? []
		return many !== undefined ? splitTopLevel(many).map(lastPart) : one !== undefined ? [lastPart(one)] : []
	})
}

/**
 * An UPDATE's or upsert's own finding: cautious when it backfills only columns in `fresh`, which
 * it then takes out, as written; unsafe otherwise
 */
function updateFinding(code: string, bare: string, fresh: Fresh): Finding | undefined {
	const write = UPDATE.exec(bare) ?? UPSERT.exec(bare)
	if (write === null) return undefined
	const indices = write.indices as RegExpIndicesArray
	const [tableStart, tableEnd] = indices[1] as [number, number]
	const [setStart] = indices[2] as [number, number]
	const end = /\b(?:FROM|WHERE|RETURNING)\b/i.exec(bare.slice(setStart))
	const columns = assigned(code.slice(setStart, end === null ? undefined : setStart + end.index))
	const table = lastPart(code.slice(tableStart, tableEnd))
	const added = fresh.columns.get(table)
	const backfill =
		fresh.tables.has(table) || (columns.length > 0 && columns.every((column) => added?.has(column) === true))
	for (const column of columns) added?.delete(column)
	return { level: backfill ? "cautious" : "unsafe" }
}

/** A write's own finding, its nested writes aside */
function ownWriteFinding(code: string, fresh: Fresh): Finding | undefined {
	if (/^MERGE\b/i.test(code)) return { level: /\bTHEN (?:DELETE|UPDATE)\b/i.test(code) ? "unsafe" : "cautious" }
	/* a quoted name is no keyword: blank it, keeping each offset */
	const bare = topLevel(code.replace(QUOTED_NAME, (name) => "_".repeat(name.length)))
	if (DELETE.test(bare) || REPLACE.test(bare)) return { level: "unsafe" }
	return updateFinding(code, bare, fresh)
}

/** The parenthesized groups of `code` at its first depth, each without its parentheses */
function groups(code: string): string[] {
	const out: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < code.length; i++) {
		if (code[i] === "(" && depth++ === 0) start = i + 1
		else if (code[i] === ")" && --depth === 0) out.push(code.slice(start, i).trim())
	}
	return out
}

/**
 * Each DELETE, UPDATE, MERGE or upsert in `code`, at any depth (a CTE, a subquery, a rule's
 * action), rated against `fresh`, the columns the file has added and nothing has written since
 */
function writeFindings(code: string, fresh: Fresh = freshStart()): Finding[] {
	const own = ownWriteFinding(code, fresh)
	const nested = groups(code).flatMap((group) =>
		/^(?:WITH|DELETE|UPDATE|MERGE)\b/i.test(group)
			? writeFindings(group, fresh)
			: groups(group).flatMap((inner) => writeFindings(inner, fresh)),
	)
	return own === undefined ? nested : [own, ...nested]
}

/** `fresh` with the table a CREATE TABLE in `code` creates, or the columns an ALTER TABLE adds */
function followAdds(code: string, fresh: Fresh): void {
	const created = CREATE.exec(code)?.[1]
	if (created !== undefined) fresh.tables.add(lastPart(created))
	const [, table, actions] = ALTER.exec(code) ?? []
	if (table === undefined || actions === undefined) return
	for (const action of splitTopLevel(actions)) {
		const column = ADD.exec(action)?.[1]
		if (column === undefined) continue
		const columns = fresh.columns.get(lastPart(table)) ?? new Set()
		fresh.columns.set(lastPart(table), columns.add(lastPart(column)))
	}
}

export { followAdds, type Fresh, freshStart, writeFindings }
