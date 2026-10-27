/**
 * What a Postgres file makes new, followed from its parse tree statement by statement: a table a
 * CREATE TABLE makes, a column an ADD COLUMN adds, each keyed as the parser names it, and a table
 * an INSERT … SELECT fills is new no longer. The rules read it to tell a backfill of a new table
 * or column from a write to rows that were there before.
 */
import type { Fresh } from "./classify-write.ts"
import { type Facts, type Node, tableOf } from "./pg-nodes.ts"

/** What followFresh reads and writes: the history's tables, and what the file made new */
type FreshContext = { facts: Facts; fresh: Fresh }

/** A CREATE TABLE makes its table new: no IF NOT EXISTS, and a name the history's trees do not show */
function freshTable(node: Node, { facts, fresh }: FreshContext): void {
	const key = tableOf(node["relation"], facts.schema).key
	if (node["if_not_exists"] !== true && !facts.tables.has(key)) fresh.tables.add(key)
}

/** An ADD COLUMN adds its column new: no IF NOT EXISTS, and one the table did not have */
function freshColumns(node: Node, { facts, fresh }: FreshContext): void {
	const key = tableOf(node["relation"], facts.schema).key
	for (const each of node["cmds"] as Node[]) {
		const cmd = each["AlterTableCmd"] as Node
		if (cmd["subtype"] !== "AT_AddColumn" || cmd["missing_ok"] === true) continue
		const column = String(((cmd["def"] as Node)["ColumnDef"] as Node)["colname"])
		if (facts.tables.get(key)?.has(column) !== true)
			fresh.columns.set(key, (fresh.columns.get(key) ?? new Set()).add(column))
	}
}

/**
 * `fresh` after one node: a table a CREATE TABLE makes new, a column an ADD COLUMN adds new, and a
 * table an INSERT … SELECT fills holds rows that were there before, so it is fresh no longer; each
 * keyed as the parser names it
 */
function followFresh(type: string, node: Node, ctx: FreshContext): void {
	if (type === "CreateStmt") freshTable(node, ctx)
	else if (type === "AlterTableStmt" && node["objtype"] === "OBJECT_TABLE") freshColumns(node, ctx)
	else if (type === "InsertStmt") {
		const select = (node["selectStmt"] as Node | undefined)?.["SelectStmt"] as Node | undefined
		if (select !== undefined && select["valuesLists"] === undefined)
			ctx.fresh.tables.delete(tableOf(node["relation"], ctx.facts.schema).key)
	}
}

export { followFresh, type FreshContext }
