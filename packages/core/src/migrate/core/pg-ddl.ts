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
import type { FreshContext } from "./pg-fresh.ts"
import { addColumn, foreignScan, inlineConstraints, REWRITES } from "./pg-column-add.ts"
import { domainFindings } from "./pg-domain.ts"
import { attachFindings, createFindings, maintenanceFindings } from "./pg-maintenance.ts"
import { partitionedKeyRecipe } from "./pg-partitioned.ts"
import { retypeFindings } from "./pg-retype.ts"
import { REWRITE_COMMANDS, tableFindings } from "./pg-table-commands.ts"
import { type Facts, names, type Node, nodesOf, tableOf, written } from "./pg-nodes.ts"

// lookup-table: the kinds a rename or a move to another schema of loses what names them: unsafe
const UNSAFE_RENAMES = /* @__PURE__ */ new Set([
	"OBJECT_ATTRIBUTE",
	"OBJECT_COLUMN",
	"OBJECT_DOMAIN",
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
	"OBJECT_DOMCONSTRAINT",
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

/** A table left with no replica identity: a publication's UPDATE and DELETE on it fail (M84) */
const NO_IDENTITY: Finding = {
	level: "cautious",
	note: "UPDATE and DELETE fail on a table a publication publishes them for",
}

/** A sequence restart, as an ALTER SEQUENCE or an identity column's SET or ADD spells it (M82) */
const RESTART: Finding = {
	level: "cautious",
	note: "restarts a sequence, as a RESTART does: its next values may repeat ones already used",
}

/** Whether `options`, an option list of a sequence or an identity, holds a RESTART */
const restarts = (options: unknown): boolean =>
	nodesOf(options).some(([type, node]) => type === "DefElem" && node["defname"] === "restart")

/** An identity made GENERATED ALWAYS, by ADD or SET: a deployed insert that writes the column then fails (P16) */
function always(cmd: Node): Finding[] {
	const def = cmd["def"] as Node
	const made =
		cmd["subtype"] === "AT_AddIdentity"
			? (def["Constraint"] as Node)["generated_when"] === "a"
			: nodesOf(def).some(
					([type, node]) =>
						type === "DefElem" &&
						node["defname"] === "generated" &&
						((node["arg"] as Node)["Integer"] as Node)["ival"] === "a".charCodeAt(0),
				)
	if (!made) return []
	return [
		{
			level: "cautious",
			note: `makes ${String(cmd["name"])} GENERATED ALWAYS: an insert that writes it then fails unless it says OVERRIDING SYSTEM VALUE`,
		},
	]
}

// lookup-table: the commands one rule rates, by subtype; undefined leaves a command to the table's rules
/** Where a command runs: the history's facts, and the key they hold its table under */
type On = { facts: Facts; key: string }

const COMMAND_RULES: Readonly<Record<string, (cmd: Node, table: string, on: On) => Finding[] | undefined>> = {
	AT_AddColumn: addColumn,
	AT_AttachPartition: (cmd, _table, { facts, key }) => {
		const partition = (cmd["def"] as Node)["PartitionCmd"] as Node
		const isDefault = (partition["bound"] as Node | undefined)?.["is_default"] === true
		return attachFindings(written(partition["name"]), isDefault ? "default" : facts.defaultPartitions.get(key))
	},
	/* an identity's RESTART resets its sequence, so the next insert may reuse an id (M82) */
	AT_AddIdentity: (cmd) => [...always(cmd), ...(restarts(cmd["def"]) ? [RESTART] : [])],
	AT_AlterColumnType: (cmd, _table, on) => retypeFindings(cmd, on),
	/* a SET DEFAULT changes no stored value; a DROP DEFAULT, with no def, changes what later writes store */
	AT_ColumnDefault: (cmd) => (cmd["def"] === undefined ? [{ level: "cautious" }] : []),
	AT_DropColumn: (cmd, table) => [{ drops: [`DROP COLUMN ${table}.${String(cmd["name"])}`], level: "unsafe" }],
	/* with no replica identity a publication's UPDATE and DELETE fail; Postgres refuses an index unfit for one (M84) */
	AT_ReplicaIdentity: (cmd) =>
		((cmd["def"] as Node)["ReplicaIdentityStmt"] as Node)["identity_type"] === "n" ? [NO_IDENTITY] : [],
	/* a new generation expression recomputes every row's stored value (M81) */
	AT_SetExpression: (cmd) => [
		{ level: "cautious", note: `recomputes every stored value of ${String(cmd["name"])}` },
		{ level: "lock", note: REWRITES },
	],
	AT_SetIdentity: (cmd) => [...always(cmd), ...(restarts(cmd["def"]) ? [RESTART] : [])],
	AT_SetNotNull: () => [{ level: "unsafe" }, { level: "lock", note: REWRITES }],
}

/** The recipe for a foreign key on the partitioned table `table`, whose ADD then attaches each partition's and scans nothing (P18 of r19) */
const partitionsFirst = (table: string): string =>
	`add it NOT VALID to each partition, VALIDATE CONSTRAINT on each in a later file, then add it to ${table}, which then scans nothing`

/**
 * A constraint ADD's findings: a foreign key or check scans every row unless NOT VALID. A foreign key
 * rewrites nothing, and blocks writes to its table and the one it references (P16 of r18). On a
 * partitioned table Postgres refuses a NOT VALID one, and a valid one scans every partition (P18 of r19).
 */
function addConstraint(cmd: Node, table: string, { facts, key }: On): Finding[] {
	const constraint = (cmd["def"] as Node)["Constraint"] as Node
	const partitioned = constraint["contype"] === "CONSTR_FOREIGN" && facts.partitioned.has(key)
	if (constraint["skip_validation"] === true) {
		if (!partitioned) return []
		throw new Error(
			`Postgres refuses a NOT VALID foreign key on the partitioned table ${table}: ${partitionsFirst(table)}`,
		)
	}
	if (constraint["contype"] === "CONSTR_CHECK") return [{ level: "lock", note: REWRITES }]
	if (constraint["contype"] !== "CONSTR_FOREIGN") return []
	const referenced = written(constraint["pktable"])
	if (partitioned) {
		const note = `scans every partition of ${table}, blocking writes to them and ${referenced}; ${partitionsFirst(table)}`
		return [{ level: "lock", note }]
	}
	return [
		{
			level: "lock",
			note: `${foreignScan(table, referenced)}; add it NOT VALID, then VALIDATE CONSTRAINT in a later file`,
		},
	]
}

/** A command on one column or constraint: its findings, or undefined for a command on the whole table */
function columnFindings(cmd: Node, table: string, on: On): Finding[] | undefined {
	const subtype = String(cmd["subtype"])
	return subtype === "AT_AddConstraint" ? addConstraint(cmd, table, on) : COMMAND_RULES[subtype]?.(cmd, table, on)
}

/** One ALTER TABLE command's findings, on `table` as written */
const commandFindings = (cmd: Node, table: string, on: On): Finding[] =>
	columnFindings(cmd, table, on) ?? tableFindings(cmd, table)

// lookup-table: the relations a move to another tablespace rewrites, besides a table: an index, a materialized view (P11 of r18)
const MOVED = /* @__PURE__ */ new Set(["OBJECT_INDEX", "OBJECT_MATVIEW"])

/**
 * An ALTER of a table or a composite type, command by command; of an index or a materialized view,
 * the move that rewrites it; a view or a sequence changes no value
 */
function alterFindings(node: Node, facts: Facts): Finding[] {
	const objtype = node["objtype"]
	const cmds = (node["cmds"] as Node[]).map((each) => each["AlterTableCmd"] as Node)
	const table = written(node["relation"])
	if (objtype === "OBJECT_TABLE" || objtype === "OBJECT_FOREIGN_TABLE")
		return cmds.flatMap((cmd) =>
			commandFindings(cmd, table, { facts, key: tableOf(node["relation"], facts.schema).key }),
		)
	/* a composite type's dropped or retyped attribute loses the values every column of the type holds */
	if (objtype === "OBJECT_TYPE")
		return cmds.some((cmd) => cmd["subtype"] === "AT_DropColumn" || cmd["subtype"] === "AT_AlterColumnType")
			? [{ level: "unsafe" }]
			: []
	/* a partitioned index has no storage: its move changes only where its partitions' indexes go next (P19 of r19) */
	const storageless =
		objtype === "OBJECT_INDEX" && facts.partitionedIndexes.has(tableOf(node["relation"], facts.schema).key)
	return MOVED.has(String(objtype)) && !storageless && cmds.some((cmd) => REWRITE_COMMANDS.has(String(cmd["subtype"])))
		? [{ level: "lock", note: REWRITES }]
		: []
}

/** An ALTER … ALL IN TABLESPACE: every relation of its kind there moves, and each is rewritten (P11 of r18) */
function moveAllFindings(node: Node): Finding[] {
	const kind = String(node["objtype"])
		.replace(/^OBJECT_/, "")
		.replace("MATVIEW", "materialized view")
		.toLowerCase()
	const from = String(node["orig_tablespacename"])
	return [{ level: "lock", note: `moves every ${kind} in tablespace ${from}, each rewritten under an exclusive lock` }]
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

// lookup-table: the DDL nodes that drop what no file can bring back: a database, a role, what a role owns
const UNSAFE_NODES = /* @__PURE__ */ new Set(["DropOwnedStmt", "DropRoleStmt", "DropdbStmt"])

// lookup-table: the DDL nodes one rule rates from the node alone, by type
const NODE_RULES: Readonly<Record<string, (node: Node) => Finding[]>> = {
	AlterDomainStmt: domainFindings,
	/* a renamed enum value no longer matches what stored rows and the deployed code name */
	AlterEnumStmt: (node) => (node["oldVal"] === undefined ? [] : [{ level: "unsafe" }]),
	AlterSeqStmt: (node) => (restarts(node["options"]) ? [RESTART] : []),
	AlterTableMoveAllStmt: moveAllFindings,
	DropStmt: dropFindings,
}

/** One DDL node's findings, read from its parse tree and the history's `facts`; undefined for a node that is not DDL these rules rate */
function ddlFindings(type: string, node: Node, facts: Facts): Finding[] | undefined {
	if (type === "AlterTableStmt") return alterFindings(node, facts)
	if (type === "RenameStmt" || type === "AlterObjectSchemaStmt") {
		const kind = String(node[type === "RenameStmt" ? "renameType" : "objectType"])
		if (UNSAFE_RENAMES.has(kind)) return [{ level: "unsafe" }]
		return CAUTIOUS_RENAMES.has(kind) && type === "RenameStmt" ? [{ level: "cautious" }] : []
	}
	if (type === "CreateStmt") return createFindings(node, facts)
	if (UNSAFE_NODES.has(type)) return [{ level: "unsafe" }]
	return NODE_RULES[type]?.(node) ?? maintenanceFindings(type, node)
}

// lookup-table: the constraints an ADD backs with an index it builds in place, under an ACCESS EXCLUSIVE lock
const INDEX_CONSTRAINTS = /* @__PURE__ */ new Set(["CONSTR_EXCLUSION", "CONSTR_PRIMARY", "CONSTR_UNIQUE"])

/**
 * The lock warnings of an ALTER TABLE that adds a primary key, unique or exclusion constraint
 * without USING INDEX on a table the file did not create (M81): it locks the table against reads
 * and writes while it builds the index. A unique or primary key can take an index built
 * concurrently first; an exclusion constraint cannot. On ONLY a partitioned table it builds
 * nothing (PA10 of r22b).
 */
function constraintIndexWarnings(node: Node, { facts, fresh }: FreshContext): Finding[] {
	if (node["objtype"] !== "OBJECT_TABLE" || fresh.tables.has(tableOf(node["relation"], facts.schema).key)) return []
	const table = written(node["relation"])
	const partitioned = facts.partitioned.has(tableOf(node["relation"], facts.schema).key)
	if (partitioned && (node["relation"] as Node)["inh"] !== true) return []
	return (node["cmds"] as Node[]).flatMap((each): Finding[] => {
		const cmd = each["AlterTableCmd"] as Node
		/* an added column's inline primary key or unique builds its index as ADD CONSTRAINT does (P6) */
		const inline = cmd["subtype"] === "AT_AddColumn"
		const constraints = inline
			? inlineConstraints(cmd)
			: cmd["subtype"] === "AT_AddConstraint"
				? [(cmd["def"] as Node)["Constraint"] as Node]
				: []
		return constraints
			.filter(
				(constraint) => INDEX_CONSTRAINTS.has(String(constraint["contype"])) && constraint["indexname"] === undefined,
			)
			.map((constraint): Finding => {
				/* PA10 of r22b: on a partitioned table it builds each partition's too, and USING INDEX is refused there */
				const locked = partitioned
					? `${table} against reads and writes, and its partitions against writes,`
					: `${table} against reads and writes`
				const first = inline ? "add the column, then " : ""
				const route = partitioned
					? partitionedKeyRecipe(table, first)
					: `${first}build it first with CREATE UNIQUE INDEX CONCURRENTLY, then ADD … USING INDEX`
				const concurrent = constraint["contype"] === "CONSTR_EXCLUSION" ? "" : `; ${route}`
				return { level: "lock", note: `locks ${locked} while it builds its index${concurrent}` }
			})
	})
}

export { constraintIndexWarnings, ddlFindings, REWRITES }
