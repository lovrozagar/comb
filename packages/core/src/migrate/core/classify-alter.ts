/**
 * The SQLite ALTER TABLE rules of the destructive-change gate; Postgres's are read from its parse
 * tree (pg-ddl.ts). An action list is split at its top-level commas and each action is read on its
 * own, so `ADD COLUMN x int, DROP COLUMN body` drops a column and `ALTER COLUMN a DROP NOT NULL`
 * adds no constraint.
 */
import { IDENT, nameKey, QNAME, splitTopLevel, unquote } from "./sql-code.ts"

/** What one statement or action makes of the migration: its level, the drops it names, and why */
type Finding = {
	drops?: string[] | undefined
	level: "cautious" | "lock" | "unsafe"
	note?: string | undefined
	/** a SQLite write the classifier leaves to the proof run's engine read (classify-sqlite-write.ts) */
	pending?: true
}

/** What the rules need from the file: the SQLite rebuilds it makes */
type AlterContext = { rebuilds: ReadonlyMap<string, ReadonlyArray<{ temp: string }>> }

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
/* the actions that keep every value: SQLite refuses all of them, so a file that holds one fails as it runs */
const CAUTIOUS_ACTION =
	/^(?:DROP CONSTRAINT|RENAME CONSTRAINT|DISABLE (?:ROW LEVEL SECURITY|TRIGGER)|(?:ENABLE|NO FORCE|FORCE) ROW LEVEL SECURITY|SET (?:UN)?LOGGED|DETACH PARTITION|OWNER TO)\b/i

/** An ALTER COLUMN action: a retype or SET NOT NULL is unsafe, a dropped default or identity cautious */
function alterColumn(rest: string): Finding[] {
	if (/^(?:SET DATA )?TYPE\b/i.test(rest) || /^SET NOT NULL\b/i.test(rest)) return [{ level: "unsafe" }]
	return /^DROP (?:DEFAULT|IDENTITY|EXPRESSION)\b/i.test(rest) ? [{ level: "cautious" }] : []
}

/** An ADD COLUMN action: NOT NULL without a default fails on a table with rows */
function addColumn(definition: string): Finding[] {
	const generated = /\bGENERATED\b/i.test(definition)
	return /\bNOT NULL\b/i.test(definition) && !/\bDEFAULT\b/i.test(definition) && !generated ? [{ level: "unsafe" }] : []
}

/** A RENAME TO: unsafe, unless it ends a SQLite rebuild by moving the copy into the table's name */
function renameTable(table: string, target: string, ctx: AlterContext): Finding[] {
	/* rebuilds are keyed folded, as SQLite resolves the names: `new_Parent` closes the rebuild of `Parent` */
	const rebuilt = ctx.rebuilds.get(nameKey(target, "sqlite")) ?? []
	const temp = nameKey(table, "sqlite")
	return rebuilt.some((rebuild) => nameKey(rebuild.temp, "sqlite") === temp) ? [] : [{ level: "unsafe" }]
}

/** Every other ALTER TABLE action comb reads; an action not listed is unsafe */
const KNOWN_ACTION =
	/^(?:ADD (?:CONSTRAINT \S+ )?(?:PRIMARY KEY|UNIQUE|EXCLUDE)\b|VALIDATE CONSTRAINT|ALTER CONSTRAINT|SET (?:LOGGED|WITHOUT CLUSTER|\()|RESET \(|REPLICA IDENTITY|CLUSTER ON|ATTACH PARTITION)\b/i

/** What the rules make of one action */
function ruleFindings(table: string, action: string, ctx: AlterContext): Finding[] {
	const dropped = DROP_COLUMN.exec(action)?.[1]
	if (dropped !== undefined) return [{ drops: [`DROP COLUMN ${unquote(table)}.${unquote(dropped)}`], level: "unsafe" }]
	const altered = ALTER_COLUMN.exec(action)?.[1]
	if (altered !== undefined) return alterColumn(altered)
	const added = ADD_COLUMN.exec(action)?.[1]
	if (added !== undefined) return addColumn(added)
	if (ADD_SCANNING_CONSTRAINT.test(action)) return []
	const renamedTo = RENAME_TO.exec(action)?.[1]
	if (renamedTo !== undefined) return renameTable(table, renamedTo, ctx)
	if (CAUTIOUS_ACTION.test(action)) return [{ level: "cautious" }]
	if (/^(?:RENAME|SET SCHEMA)\b/i.test(action)) return [{ level: "unsafe" }]
	return KNOWN_ACTION.test(action)
		? []
		: [
				{
					level: "unsafe",
					note: `comb does not recognize ALTER TABLE … ${action.split(" ").slice(0, 2).join(" ")}; approve it in the file`,
				},
			]
}

/** The findings of an ALTER TABLE, action by action; undefined for code that is not one */
function alterTableFindings(code: string, ctx: AlterContext): Finding[] | undefined {
	const [, table, actions] = ALTER_TABLE.exec(code) ?? []
	if (table === undefined || actions === undefined) return undefined
	return splitTopLevel(actions).flatMap((action) => ruleFindings(table, action, ctx))
}

export { alterTableFindings, type Finding }
