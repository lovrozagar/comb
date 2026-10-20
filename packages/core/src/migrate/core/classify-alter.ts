/**
 * The ALTER TABLE rules of the destructive-change gate. An action list is split at its top-level
 * commas and each action is read on its own, so `ADD COLUMN x int, DROP COLUMN body` drops a
 * column and `ALTER COLUMN a DROP NOT NULL` adds no constraint.
 */
import type { Dialect } from "../types.ts"
import { IDENT, lastPart, QNAME, splitTopLevel, unquote } from "./sql-code.ts"

/** What one statement or action makes of the migration: its level, the drops it names, and why */
type Finding = { drops?: string[] | undefined; level: "cautious" | "lock" | "unsafe"; note?: string | undefined }

/** What the rules need from the file: the dialect, and the SQLite rebuilds it makes */
type AlterContext = { dialect: Dialect; rebuilds: ReadonlyMap<string, { temp: string }> }

// per-process-constant: a pattern composed from the name grammar, compiled once
const ALTER_TABLE = /* @__PURE__ */ new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${QNAME})(?: \\*)? (.+)$`, "i")
// per-process-constant: a pattern composed from the name grammar, compiled once
const DROP_COLUMN = /* @__PURE__ */ new RegExp(`^DROP (?:COLUMN )?(?!CONSTRAINT\\b)(?:IF EXISTS )?(${IDENT})`, "i")
// per-process-constant: a pattern composed from the name grammar, compiled once
const ALTER_COLUMN = /* @__PURE__ */ new RegExp(`^ALTER (?:COLUMN )?(?:${IDENT}) (.+)$`, "i")
// per-process-constant: a pattern composed from the name grammar, compiled once
const ADD_COLUMN = /* @__PURE__ */ new RegExp(
	`^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(?!(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\\b)(?:${IDENT}) (.+)$`,
	"i",
)
// per-process-constant: a pattern composed from the name grammar, compiled once
const ADD_SCANNING_CONSTRAINT = /* @__PURE__ */ new RegExp(
	`^ADD (?:CONSTRAINT ${IDENT} )?(?:FOREIGN KEY|CHECK)\\b`,
	"i",
)
// per-process-constant: a pattern composed from the name grammar, compiled once
const RENAME_TO = /* @__PURE__ */ new RegExp(`^RENAME TO (${QNAME})$`, "i")
const CAUTIOUS_ACTION =
	/^(?:DROP CONSTRAINT|RENAME CONSTRAINT|DISABLE (?:ROW LEVEL SECURITY|TRIGGER)|NO FORCE ROW LEVEL SECURITY|SET UNLOGGED|DETACH PARTITION|OWNER TO)\b/i
/* a default these compute per row rewrites the whole table when the column is added */
const VOLATILE_DEFAULT =
	/\bDEFAULT\b.*\b(?:clock_timestamp|random|gen_random_uuid|uuid_generate_v1|uuid_generate_v1mc|uuid_generate_v4|timeofday|nextval)\s*\(/i
const REWRITES = "rewrites or scans the table under an exclusive lock"

/** An ALTER COLUMN action: a retype or SET NOT NULL is unsafe, a dropped default or identity cautious */
function alterColumn(rest: string, pg: boolean): Finding[] {
	if (/^(?:SET DATA )?TYPE\b/i.test(rest) || /^SET NOT NULL\b/i.test(rest)) {
		return pg ? [{ level: "unsafe" }, { level: "lock", note: REWRITES }] : [{ level: "unsafe" }]
	}
	return /^DROP (?:DEFAULT|IDENTITY|EXPRESSION)\b/i.test(rest) ? [{ level: "cautious" }] : []
}

/** An ADD COLUMN action: NOT NULL without a default fails on a table with rows; a volatile default rewrites it */
function addColumn(definition: string, pg: boolean): Finding[] {
	const findings: Finding[] = []
	const generated = /\bGENERATED\b/i.test(definition)
	if (/\bNOT NULL\b/i.test(definition) && !/\bDEFAULT\b/i.test(definition) && !generated)
		findings.push({ level: "unsafe" })
	if (pg && VOLATILE_DEFAULT.test(definition)) findings.push({ level: "lock", note: REWRITES })
	return findings
}

/** A RENAME TO: unsafe, unless it ends a SQLite rebuild by moving the copy into the table's name */
function renameTable(table: string, target: string, ctx: AlterContext): Finding[] {
	const rebuild = ctx.rebuilds.get(lastPart(target))
	return rebuild !== undefined && rebuild.temp === lastPart(table) ? [] : [{ level: "unsafe" }]
}

/** One action of the list */
function actionFindings(table: string, action: string, ctx: AlterContext): Finding[] {
	const pg = ctx.dialect === "postgres"
	const dropped = DROP_COLUMN.exec(action)?.[1]
	if (dropped !== undefined) return [{ drops: [`DROP COLUMN ${unquote(table)}.${unquote(dropped)}`], level: "unsafe" }]
	const altered = ALTER_COLUMN.exec(action)?.[1]
	if (altered !== undefined) return alterColumn(altered, pg)
	const added = ADD_COLUMN.exec(action)?.[1]
	if (added !== undefined) return addColumn(added, pg)
	if (ADD_SCANNING_CONSTRAINT.test(action)) {
		return pg && !/\bNOT VALID\b/i.test(action) ? [{ level: "lock", note: REWRITES }] : []
	}
	const renamedTo = RENAME_TO.exec(action)?.[1]
	if (renamedTo !== undefined) return renameTable(table, renamedTo, ctx)
	if (CAUTIOUS_ACTION.test(action)) return [{ level: "cautious" }]
	return /^(?:RENAME|SET SCHEMA)\b/i.test(action) ? [{ level: "unsafe" }] : []
}

/** The findings of an ALTER TABLE, action by action; undefined for code that is not one */
function alterTableFindings(code: string, ctx: AlterContext): Finding[] | undefined {
	const [, table, actions] = ALTER_TABLE.exec(code) ?? []
	if (table === undefined || actions === undefined) return undefined
	return splitTopLevel(actions).flatMap((action) => actionFindings(table, action, ctx))
}

export { alterTableFindings, type Finding }
