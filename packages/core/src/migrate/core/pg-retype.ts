/**
 * A retype's findings: unsafe, with the rewrite warning, as a retype can change every value and
 * rewrites the table, but for one Postgres does in place, which changes no value: a retype with no
 * USING that only widens, read against the column's type in the history (P12 of the 0.15.0 review).
 * Widening is a longer or unbounded varchar, or text; a numeric of more or unbounded precision at
 * the same scale; a longer or unbounded varbit.
 */
import type { Finding } from "./classify-alter.ts"
import { REWRITES } from "./pg-column-add.ts"
import { type ColumnType, type Facts, modsOf, type Node, typeOf } from "./pg-nodes.ts"

// lookup-table: the types whose modifier bounds a value's length or precision, so a larger one only widens
const BOUNDED: ReadonlySet<string> = /* @__PURE__ */ new Set(["numeric", "varbit", "varchar"])

/** A type's name without the catalog schema the parser writes for a built-in */
const bare = (type: string): string => type.replace(/^pg_catalog\./, "")

/** Whether a column of type `from` retyped to `to` keeps every value as it is */
function widens(from: ColumnType, to: ColumnType): boolean {
	const [was, now] = [bare(from.type), bare(to.type)]
	if (was === "varchar" && now === "text") return true
	if (was !== now || !BOUNDED.has(was)) return false
	if (to.mods.length === 0) return true
	const [bound = Number.NaN, scale = 0] = from.mods
	const [wider = Number.NaN, kept = 0] = to.mods
	return wider >= bound && (was !== "numeric" || kept === scale)
}

/** An ALTER COLUMN … TYPE's findings, on the table `key` names in `facts` */
function retypeFindings(cmd: Node, { facts, key }: { facts: Facts; key: string }): Finding[] {
	const def = (cmd["def"] as Node)["ColumnDef"] as Node
	const from = facts.columnTypes.get(key)?.get(String(cmd["name"]))
	const to = { mods: modsOf(def["typeName"]), type: typeOf(def["typeName"], facts.schema) }
	if (def["raw_default"] === undefined && from !== undefined && widens(from, to)) return []
	return [{ level: "unsafe" }, { level: "lock", note: REWRITES }]
}

export { retypeFindings }
