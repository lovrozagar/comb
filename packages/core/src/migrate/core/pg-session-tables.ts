/**
 * The relations a statement on rows may run code through (comb-9d's per-table ruling on PA1 of
 * r22b), as the files hold them: a trigger, a rule, a policy, or a default, generated column, check
 * or index that calls a function outside pg_catalog; and the pairs a flag carries along: a child or
 * partition to its parent, a table to a view reading it, a table to the one its cascading foreign
 * key references, and a rename both ways. pg-session.ts reads a file's runs by them.
 */
import { names, type Node } from "./pg-nodes.ts"

/** A statement's one node, its type and fields, none for a statement the parser cannot read */
const nodeOf = (tree: unknown): [string, Node] | undefined =>
	tree === undefined ? undefined : (Object.entries((tree as [{ stmt: Node }])[0].stmt)[0] as [string, Node])

/** Each relation the tree names, by its name in any schema */
function relationsIn(tree: unknown, found: Set<string> = new Set<string>()): Set<string> {
	if (tree === null || typeof tree !== "object") return found
	const name = (tree as { relname?: unknown }).relname
	if (typeof name === "string") found.add(name)
	for (const value of Object.values(tree)) relationsIn(value, found)
	return found
}

/** Whether the tree `tree` calls a function outside pg_catalog: a qualified one in another schema, or an unqualified one of `own` */
function callsOwn(tree: unknown, own: ReadonlySet<string>): boolean {
	if (tree === null || typeof tree !== "object") return false
	const call = (tree as { FuncCall?: Node | undefined }).FuncCall
	if (call !== undefined) {
		const parts = names(call["funcname"])
		if (parts.length === 1 ? own.has(parts[0] as string) : parts[0] !== "pg_catalog") return true
	}
	return Object.values(tree).some((value) => callsOwn(value, own))
}

/* CASCADE, SET NULL and SET DEFAULT */
// lookup-table: the foreign-key actions that write the referencing table
const WRITES_BACK: ReadonlySet<string> = /* @__PURE__ */ new Set(["c", "n", "d"])

/** A relation's name in any schema, from a RangeVar bare or wrapped */
const relationOf = (rel: unknown): string | undefined => {
	const bare = rel as { RangeVar?: { relname: string } | undefined; relname?: string | undefined } | undefined
	return bare?.relname ?? bare?.RangeVar?.relname
}

/** The tables and views the files hold code on, and the pairs a flag on the first of carries to the second */
type Relations = { holds: Set<string>; carries: Array<readonly [string, string]> }

/** Each cascading foreign key in `tree`, as a flag on `table` carrying to the table it references */
function foreignKeys(tree: unknown, table: string, relations: Relations): void {
	if (tree === null || typeof tree !== "object") return
	const key = (tree as { Constraint?: Node | undefined }).Constraint
	const references = relationOf(key?.["pktable"])
	if (
		key?.["contype"] === "CONSTR_FOREIGN" &&
		references !== undefined &&
		(WRITES_BACK.has(String(key["fk_del_action"])) || WRITES_BACK.has(String(key["fk_upd_action"])))
	)
		relations.carries.push([table, references])
	for (const value of Object.values(tree)) foreignKeys(value, table, relations)
}

/** What the files hold of code a relation's statements read, and the names an unqualified call reaches */
type Facts = { own: ReadonlySet<string>; relations: Relations }

/** A statement that names a relation: its node, of its type, and the relation's name */
type Named = { node: Node; table: string; type: string }

/** What a table's or an index's statement holds on the table it names, and carries from it */
function tableFacts({ node, table, type }: Named, { own, relations }: Facts): void {
	const stored = type === "IndexStmt" ? [node["indexParams"], node["whereClause"]] : node
	if (callsOwn(stored, own)) relations.holds.add(table)
	foreignKeys(node, table, relations)
	for (const parent of (node["inhRelations"] as unknown[] | undefined) ?? [])
		relations.carries.push([table, relationOf(parent) as string])
	for (const { AlterTableCmd } of (node["cmds"] as Array<{ AlterTableCmd: Node }> | undefined) ?? []) {
		const def = AlterTableCmd["def"] as Node | undefined
		if (AlterTableCmd["subtype"] === "AT_AttachPartition")
			relations.carries.push([relationOf(((def as Node)["PartitionCmd"] as Node)["name"]) as string, table])
		if (AlterTableCmd["subtype"] === "AT_AddInherit") relations.carries.push([table, relationOf(def) as string])
	}
}

/** The view or materialized view the statement `node` of `type` makes, none for another statement */
function viewOf(type: string, node: Node): string | undefined {
	if (type === "ViewStmt") return relationOf(node["view"])
	if (type === "CreateTableAsStmt" && node["objtype"] === "OBJECT_MATVIEW")
		return relationOf((node["into"] as Node)["rel"])
	return undefined
}

/** What a statement holds on the relation it names, and carries from it */
function namedFacts(named: Named, facts: Facts): void {
	const { node, table, type } = named
	if (type === "CreateTrigStmt" || type === "RuleStmt") facts.relations.holds.add(table)
	if (type === "CreateStmt" || type === "AlterTableStmt" || type === "IndexStmt") tableFacts(named, facts)
	if (type === "RenameStmt" && node["renameType"] !== "OBJECT_COLUMN") {
		const renamed = String(node["newname"])
		facts.relations.carries.push([table, renamed], [renamed, table])
	}
}

/** What the statement `tree` holds on relations, and carries between them */
function relationFacts(tree: unknown, facts: Facts): void {
	const [type, node] = nodeOf(tree) ?? ["", {}]
	if (type === "CreateSchemaStmt")
		for (const element of (node["schemaElts"] as unknown[] | undefined) ?? []) relationFacts([{ stmt: element }], facts)
	const table = relationOf(node["relation"])
	if (table !== undefined) namedFacts({ node, table, type }, facts)
	if (type === "CreatePolicyStmt") facts.relations.holds.add(relationOf(node["table"]) as string)
	const view = viewOf(type, node)
	if (view === undefined) return
	if (callsOwn(node["query"], facts.own)) facts.relations.holds.add(view)
	for (const read of relationsIn(node["query"])) facts.relations.carries.push([read, view])
}

/** The relations `holds` names, closed over `carries` */
function closed({ carries, holds }: Relations): Set<string> {
	const tables = new Set(holds)
	for (let grew = true; grew;) {
		grew = false
		for (const [from, to] of carries)
			if (tables.has(from) && !tables.has(to)) {
				tables.add(to)
				grew = true
			}
	}
	return tables
}

export { callsOwn, closed, nodeOf, relationFacts, type Relations, relationsIn }
