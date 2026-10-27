/**
 * Postgres DDL rated from its parse tree, as its writes are (pg-tree.ts), so no spelling the parser
 * accepts hides a dropped column, a retype, a rename or a drop (M70):
 *
 * - an ALTER TABLE by each command's subtype: a dropped column, a retype and SET NOT NULL unsafe, a
 *   dropped constraint, default, identity or expression, row level security, a disabled trigger,
 *   SET LOGGED or UNLOGGED, a detached partition and a new owner cautious, a new tablespace or
 *   access method and SET (UN)LOGGED a rewrite under an exclusive lock, the commands that change no
 *   value rated by nothing, and any subtype not listed unsafe;
 * - a rename or a move to another schema by the kind of object, an enum value renamed unsafe;
 * - a drop by its kind, its names as the parser reads them.
 *
 * The tables and columns a file makes new, which a backfill may fill, are keyed as the parser names
 * them, against the tables the history's trees made (pg-history.ts).
 */
import type { Finding } from "./classify-alter.ts"
import type { Fresh } from "./classify-write.ts"
import { type Facts, names, type Node, nodesOf, tableOf } from "./pg-nodes.ts"

const REWRITES = "rewrites or scans the table under an exclusive lock"

// lookup-table: the functions a default computes per row, so adding the column rewrites the table
const VOLATILE = /* @__PURE__ */ new Set([
	"clock_timestamp",
	"gen_random_uuid",
	"nextval",
	"random",
	"timeofday",
	"uuid_generate_v1",
	"uuid_generate_v1mc",
	"uuid_generate_v4",
])

// lookup-table: the ALTER TABLE commands that change which rows a role sees, or what keeps them, and lose no value
const CAUTIOUS_COMMANDS = /* @__PURE__ */ new Set([
	"AT_ChangeOwner",
	"AT_ColumnDefault",
	"AT_DetachPartition",
	"AT_DetachPartitionFinalize",
	"AT_DisableTrig",
	"AT_DisableTrigAll",
	"AT_DisableTrigUser",
	"AT_DropConstraint",
	"AT_DropExpression",
	"AT_DropIdentity",
])

// lookup-table: the ALTER TABLE commands that rewrite the whole table under an ACCESS EXCLUSIVE lock and lose no value
const REWRITE_COMMANDS = /* @__PURE__ */ new Set(["AT_SetAccessMethod", "AT_SetTableSpace"])

// lookup-table: the row level security commands, cautious, each saying whose rows it changes
const SECURITY_COMMANDS = /* @__PURE__ */ new Set([
	"AT_DisableRowSecurity",
	"AT_EnableRowSecurity",
	"AT_ForceRowSecurity",
	"AT_NoForceRowSecurity",
])

// lookup-table: the ALTER TABLE commands that change no stored value, rated by nothing
const QUIET_COMMANDS = /* @__PURE__ */ new Set([
	"AT_AddIdentity",
	"AT_AlterConstraint",
	"AT_AttachPartition",
	"AT_ClusterOn",
	"AT_DropCluster",
	"AT_DropNotNull",
	"AT_ReplicaIdentity",
	"AT_ResetOptions",
	"AT_ResetRelOptions",
	"AT_SetCompression",
	"AT_SetIdentity",
	"AT_SetOptions",
	"AT_SetRelOptions",
	"AT_SetStatistics",
	"AT_SetStorage",
	"AT_ValidateConstraint",
])

// lookup-table: the kinds a rename or a move to another schema of loses what names them: unsafe
const UNSAFE_RENAMES = /* @__PURE__ */ new Set([
	"OBJECT_ATTRIBUTE",
	"OBJECT_COLUMN",
	"OBJECT_FOREIGN_TABLE",
	"OBJECT_MATVIEW",
	"OBJECT_SCHEMA",
	"OBJECT_TABLE",
	"OBJECT_TYPE",
	"OBJECT_VIEW",
])

// lookup-table: the kinds whose rename only callers by name notice: cautious
const CAUTIOUS_RENAMES = /* @__PURE__ */ new Set([
	"OBJECT_AGGREGATE",
	"OBJECT_FUNCTION",
	"OBJECT_INDEX",
	"OBJECT_POLICY",
	"OBJECT_PROCEDURE",
	"OBJECT_ROUTINE",
	"OBJECT_SEQUENCE",
	"OBJECT_TABCONSTRAINT",
	"OBJECT_TRIGGER",
])

// lookup-table: the kinds a DROP of loses data or what holds it: unsafe; every other drop is cautious
const UNSAFE_DROPS = /* @__PURE__ */ new Set([
	"OBJECT_DOMAIN",
	"OBJECT_EXTENSION",
	"OBJECT_FOREIGN_TABLE",
	"OBJECT_MATVIEW",
	"OBJECT_SCHEMA",
	"OBJECT_SEQUENCE",
	"OBJECT_TABLE",
	"OBJECT_TYPE",
])

// lookup-table: the drops whose objects are named in the drop list, by the word the list writes
const NAMED_DROPS: Readonly<Record<string, string>> = { OBJECT_INDEX: "INDEX", OBJECT_TABLE: "TABLE" }

/** A RangeVar as written, its schema with it */
const written = (relation: unknown): string => {
	const rel = relation as { relname: string; schemaname?: string }
	return rel.schemaname === undefined ? rel.relname : `${rel.schemaname}.${rel.relname}`
}

/** An added column's findings: NOT NULL without a default fails on a table with rows; a volatile default rewrites it */
function addColumn(def: Node): Finding[] {
	const column = def["ColumnDef"] as Node
	const constraints = ((column["constraints"] as Node[] | undefined) ?? []).map((each) => each["Constraint"] as Node)
	const has = (type: string) => constraints.some((each) => each["contype"] === type)
	const findings: Finding[] = []
	if (has("CONSTR_NOTNULL") && !has("CONSTR_DEFAULT") && !has("CONSTR_GENERATED") && !has("CONSTR_IDENTITY"))
		findings.push({ level: "unsafe" })
	const defaults = constraints.filter((each) => each["contype"] === "CONSTR_DEFAULT")
	const volatile = nodesOf(defaults.map((each) => each["raw_expr"])).some(
		([type, node]) => type === "FuncCall" && VOLATILE.has(names(node["funcname"]).at(-1) as string),
	)
	if (volatile) findings.push({ level: "lock", note: REWRITES })
	return findings
}

/** A command on one column or constraint: its findings, or undefined for a command on the whole table */
function columnFindings(cmd: Node, table: string): Finding[] | undefined {
	const subtype = String(cmd["subtype"])
	if (subtype === "AT_DropColumn") return [{ drops: [`DROP COLUMN ${table}.${String(cmd["name"])}`], level: "unsafe" }]
	if (subtype === "AT_AlterColumnType" || subtype === "AT_SetNotNull")
		return [{ level: "unsafe" }, { level: "lock", note: REWRITES }]
	if (subtype === "AT_AddColumn") return addColumn(cmd["def"] as Node)
	/* a new generation expression recomputes every row's stored value (M81) */
	if (subtype === "AT_SetExpression")
		return [
			{ level: "cautious", note: `recomputes every stored value of ${String(cmd["name"])}` },
			{ level: "lock", note: REWRITES },
		]
	if (subtype === "AT_AddConstraint") {
		const constraint = (cmd["def"] as Node)["Constraint"] as Node
		const scans = constraint["contype"] === "CONSTR_FOREIGN" || constraint["contype"] === "CONSTR_CHECK"
		return scans && constraint["skip_validation"] !== true ? [{ level: "lock", note: REWRITES }] : []
	}
	/* a SET DEFAULT changes no stored value; a DROP DEFAULT, with no def, changes what later writes store */
	if (subtype === "AT_ColumnDefault") return cmd["def"] === undefined ? [{ level: "cautious" }] : []
	return undefined
}

/** A command on the whole table: its findings; one comb does not list is unsafe, named in words */
function tableFindings(subtype: string, table: string): Finding[] {
	if (CAUTIOUS_COMMANDS.has(subtype)) return [{ level: "cautious" }]
	if (REWRITE_COMMANDS.has(subtype)) return [{ level: "lock", note: REWRITES }]
	/* SET LOGGED and SET UNLOGGED rewrite the table; an unlogged one loses its rows to a crash */
	if (subtype === "AT_SetLogged") return [{ level: "cautious" }, { level: "lock", note: REWRITES }]
	if (subtype === "AT_SetUnLogged")
		return [
			{ level: "cautious", note: `makes ${table} unlogged: its rows are emptied after a crash and not replicated` },
			{ level: "lock", note: REWRITES },
		]
	if (SECURITY_COMMANDS.has(subtype))
		return [{ level: "cautious", note: `changes which rows each role sees on ${table}` }]
	if (QUIET_COMMANDS.has(subtype)) return []
	/* the parser keeps no text of a command: its subtype in words, AT_AddInherit as ADD INHERIT */
	const action = subtype
		.replace(/^AT_/, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toUpperCase()
	return [{ level: "unsafe", note: `comb does not recognize ALTER TABLE … ${action}; approve it in the file` }]
}

/** One ALTER TABLE command's findings, on `table` as written */
const commandFindings = (cmd: Node, table: string): Finding[] =>
	columnFindings(cmd, table) ?? tableFindings(String(cmd["subtype"]), table)

/** An ALTER of a table or a composite type, command by command; an index, view or sequence changes no value */
function alterFindings(node: Node): Finding[] {
	const objtype = node["objtype"]
	const cmds = (node["cmds"] as Node[]).map((each) => each["AlterTableCmd"] as Node)
	const table = written(node["relation"])
	if (objtype === "OBJECT_TABLE" || objtype === "OBJECT_FOREIGN_TABLE")
		return cmds.flatMap((cmd) => commandFindings(cmd, table))
	/* a composite type's dropped or retyped attribute loses the values every column of the type holds */
	if (objtype === "OBJECT_TYPE")
		return cmds.some((cmd) => cmd["subtype"] === "AT_DropColumn" || cmd["subtype"] === "AT_AlterColumnType")
			? [{ level: "unsafe" }]
			: []
	return []
}

/** A drop's findings: its level by kind, and the tables and indexes it names */
function dropFindings(node: Node): Finding[] {
	const kind = String(node["removeType"])
	const word = NAMED_DROPS[kind]
	const drops =
		word === undefined
			? []
			: (node["objects"] as Node[]).map(
					(object) => `DROP ${word} ${names((object["List"] as Node)["items"]).join(".")}`,
				)
	return [{ drops, level: UNSAFE_DROPS.has(kind) ? "unsafe" : "cautious" }]
}

/** One DDL node's findings, read from its parse tree; undefined for a node that is not DDL these rules rate */
function ddlFindings(type: string, node: Node): Finding[] | undefined {
	if (type === "AlterTableStmt") return alterFindings(node)
	if (type === "RenameStmt" || type === "AlterObjectSchemaStmt") {
		const kind = String(node[type === "RenameStmt" ? "renameType" : "objectType"])
		if (UNSAFE_RENAMES.has(kind)) return [{ level: "unsafe" }]
		return CAUTIOUS_RENAMES.has(kind) && type === "RenameStmt" ? [{ level: "cautious" }] : []
	}
	/* a renamed enum value no longer matches what stored rows and the deployed code name */
	if (type === "AlterEnumStmt") return node["oldVal"] === undefined ? [] : [{ level: "unsafe" }]
	if (type === "DropStmt") return dropFindings(node)
	if (type === "DropdbStmt" || type === "DropRoleStmt" || type === "DropOwnedStmt") return [{ level: "unsafe" }]
	return undefined
}

/** What followFresh reads and writes: the history's tables, and what the file made new */
type FreshContext = { facts: Facts; fresh: Fresh }

// lookup-table: the constraints an ADD backs with an index it builds in place, under an ACCESS EXCLUSIVE lock
const INDEX_CONSTRAINTS = /* @__PURE__ */ new Set(["CONSTR_EXCLUSION", "CONSTR_PRIMARY", "CONSTR_UNIQUE"])

/**
 * The lock warnings of an ALTER TABLE that adds a primary key, unique or exclusion constraint
 * without USING INDEX on a table the file did not create (M81): it locks the table against reads
 * and writes while it builds the index. A unique or primary key can take an index built
 * concurrently first; an exclusion constraint cannot.
 */
function constraintIndexWarnings(node: Node, { facts, fresh }: FreshContext): Finding[] {
	if (node["objtype"] !== "OBJECT_TABLE" || fresh.tables.has(tableOf(node["relation"], facts.schema).key)) return []
	const table = written(node["relation"])
	return (node["cmds"] as Node[]).flatMap((each): Finding[] => {
		const cmd = each["AlterTableCmd"] as Node
		const constraint = cmd["subtype"] === "AT_AddConstraint" ? ((cmd["def"] as Node)["Constraint"] as Node) : undefined
		if (constraint === undefined || !INDEX_CONSTRAINTS.has(String(constraint["contype"]))) return []
		if (constraint["indexname"] !== undefined) return []
		const concurrent =
			constraint["contype"] === "CONSTR_EXCLUSION"
				? ""
				: "; build it first with CREATE UNIQUE INDEX CONCURRENTLY, then ADD … USING INDEX"
		return [{ level: "lock", note: `locks ${table} against reads and writes while it builds its index${concurrent}` }]
	})
}

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

export { constraintIndexWarnings, ddlFindings, followFresh, REWRITES }
