/**
 * What the SQLite classifier makes of a write on its own, for a caller that runs no proof. The
 * proof run reads what each statement writes from SQLite itself (proof-engine.ts); the classifier
 * reads only text, so it clears just what text can show: any write to a table the file created,
 * a backfill of only the columns the file added (cautious, once), and an insert no history trigger
 * watches that replaces nothing. A table whose definition replaces on conflict (`ON CONFLICT
 * REPLACE`, in the history or made in the file) is never cleared: a plain insert into it deletes
 * the row it meets. Every other write, and any it cannot read, is unsafe, pending the
 * proof run's read: planApply's proof replaces those entries with the engine's own findings.
 */
import type { ExtractedSchema } from "../types.ts"
import type { Finding } from "./classify-alter.ts"
import type { Fresh } from "./classify-write.ts"
import { IDENT, lastPart, nameKey, QNAME, qualifiedKey, splitTopLevel, topLevel } from "./sql-code.ts"

/** A finding the proof run's engine findings replace */
type Pending = Finding & { pending: true }

const PENDING: Pending = { level: "unsafe", note: "pending the proof run's read of what it writes", pending: true }

const CTE = "^(?:WITH\\b.*?\\b)?"
// per-process-constant: a write's verb, after any CTE
const VERB = /* @__PURE__ */ new RegExp(`${CTE}(INSERT|REPLACE|UPDATE|DELETE)\\b`, "i")
// per-process-constant: an INSERT's or REPLACE's conflict clause and table
const INSERT = /* @__PURE__ */ new RegExp(`${CTE}(?:INSERT(?: OR (\\w+))?|REPLACE) INTO (${QNAME})`, "i")
// per-process-constant: an UPDATE's conflict clause, table, and where its SET list starts
const UPDATE = /* @__PURE__ */ new RegExp(`${CTE}UPDATE(?: OR (\\w+))? (${QNAME})(?: (?:AS )?${IDENT})? SET `, "i")
// per-process-constant: a DELETE's table
const DELETE = /* @__PURE__ */ new RegExp(`${CTE}DELETE FROM (${QNAME})`, "i")
// per-process-constant: one assignment's column, or a parenthesized list of them
const ASSIGNED = /* @__PURE__ */ new RegExp(`^(?:\\(([^)]*)\\)|(${QNAME})) ?=`)

/** The columns a SET list assigns, `code` from the list's start, `bare` the same with groups blanked */
function assigned(code: string, bare: string): string[] {
	const end = /\b(?:FROM|WHERE|RETURNING)\b/i.exec(bare)
	return splitTopLevel(code.slice(0, end?.index)).flatMap((assignment) => {
		const [, many, one] = ASSIGNED.exec(assignment) ?? []
		return many !== undefined ? splitTopLevel(many).map(lastPart) : one !== undefined ? [lastPart(one)] : []
	})
}

/** An UPDATE's or upsert's finding: a backfill of only the columns `fresh` holds, which it then takes out; pending otherwise */
function setFinding(table: string, columns: readonly string[], fresh: Fresh): Finding {
	const added = fresh.columns.get(qualifiedKey(table, "sqlite"))
	if (columns.length === 0 || !columns.every((column) => added?.has(column) === true)) return PENDING
	for (const column of columns) added?.delete(column)
	return { level: "cautious", note: `backfills ${lastPart(table)} (${columns.join(", ")}), new in this file` }
}

/** An INSERT's finding: a REPLACE or an upsert is a write over rows; a plain one only fires the history's insert triggers */
function insertFinding(
	verb: string,
	[code, bare]: [string, string],
	ctx: { before?: ExtractedSchema | undefined; fresh: Fresh },
): Finding[] {
	const [, conflict, table] = INSERT.exec(bare) as RegExpExecArray
	if (verb === "REPLACE" || conflict?.toUpperCase() === "REPLACE") return [PENDING]
	const upsert = /\bON CONFLICT\b.*?\bDO UPDATE SET /i.exec(bare)
	if (upsert !== null) {
		const start = upsert.index + upsert[0].length
		return [setFinding(table as string, assigned(code.slice(start), bare.slice(start)), ctx.fresh)]
	}
	const name = lastPart(table as string).toLowerCase()
	const watched = (ctx.before?.triggers ?? []).some(
		(trigger) => trigger.table === name && trigger.events.includes("insert"),
	)
	return watched ? [PENDING] : []
}

/**
 * What the table alone settles: any write to a table that replaces on conflict is held for the
 * engine, and any other write to a table the file created is cleared; undefined when neither
 */
function byTable(table: string, ctx: { fresh: Fresh; schema: ExtractedSchema }): Finding[] | undefined {
	const conflicts = ctx.schema.tableInfo.get(nameKey(table, "sqlite"))?.conflicts ?? []
	if (conflicts.some((conflict) => conflict.endsWith(": REPLACE"))) return [PENDING]
	return ctx.fresh.tables.has(qualifiedKey(table, "sqlite")) ? [] : undefined
}

/** What the classifier makes of `code` when it is a SQLite write; nothing when it is none */
function sqliteWriteFindings(
	code: string,
	ctx: { before?: ExtractedSchema | undefined; fresh: Fresh; schema: ExtractedSchema },
): Finding[] {
	const bare = topLevel(code)
	const verb = VERB.exec(bare)?.[1]?.toUpperCase()
	if (verb === undefined) return []
	const named = (verb === "DELETE" ? DELETE : verb === "UPDATE" ? UPDATE : INSERT).exec(bare)
	if (named === null) return [PENDING]
	const table = named[verb === "DELETE" ? 1 : 2] as string
	const settled = byTable(table, ctx)
	if (settled !== undefined) return settled
	if (verb === "DELETE") return [PENDING]
	if (verb !== "UPDATE") return insertFinding(verb, [code, bare], ctx)
	if (named[1]?.toUpperCase() === "REPLACE") return [PENDING]
	const start = named[0].length
	return [setFinding(table, assigned(code.slice(start), bare.slice(start)), ctx.fresh)]
}

export { type Pending, sqliteWriteFindings }
