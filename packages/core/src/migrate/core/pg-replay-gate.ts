/**
 * Whether a Postgres history may make anything baseline's catalog read compares (pg-live-catalog.ts),
 * the gate a docker:// dev database is held to: Atlas's own container, which comb cannot reach, so a
 * history that may make any such object is refused naming devUrl, and one that makes none
 * needs no replay. It fails closed: a statement passes only when its node is one proved to
 * make nothing the read compares, so a statement no one thought of is refused, not let through.
 */
import { nodeOf } from "./pg-outside-transaction.ts"
import type { HistoryFile } from "./pg-replay.ts"
import { pgRead } from "./pg-split.ts"

type Node = Record<string, unknown>

/** Whether a statement's node, of a type the gate knows, makes nothing the catalog read compares */
type Inert = (node: Node) => boolean

const always: Inert = () => true

/**
 * The ALTER TABLE commands on a table's columns, constraints, partitions and storage options, which
 * make nothing the read compares: a column's serial or identity sequence is the column's, left out of
 * the read, and a constraint's triggers are internal
 */
// lookup-table: the ALTER TABLE subtypes proved inert on a table
const TABLE_COMMANDS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"AT_AddColumn",
	"AT_AddConstraint",
	"AT_AddIdentity",
	"AT_AlterColumnType",
	"AT_AlterConstraint",
	"AT_AttachPartition",
	"AT_ColumnDefault",
	"AT_DetachPartition",
	"AT_DropColumn",
	"AT_DropConstraint",
	"AT_DropIdentity",
	"AT_DropNotNull",
	"AT_ResetRelOptions",
	"AT_SetIdentity",
	"AT_SetNotNull",
	"AT_SetRelOptions",
	"AT_ValidateConstraint",
])

/* an OWNED BY NONE frees a column's sequence into what the read compares; any other option leaves it the column's */
const OWNED_BY_NONE = '{"List":{"items":[{"String":{"sval":"none"}}]}}'
const freesSequence = (node: Node): boolean =>
	(node["options"] as Array<{ DefElem: Node }>).some(
		({ DefElem }) => DefElem["defname"] === "owned_by" && JSON.stringify(DefElem["arg"]) === OWNED_BY_NONE,
	)

/**
 * Each statement node proved to make nothing the catalog read compares, with what it must hold to be;
 * tests/integration/postgres/replay-gate.test.ts runs one of each on Postgres and reads the catalog
 * after, so an arm the read gains is checked against every entry. A table, an index, an enum, a schema
 * without elements, a plain CREATE TABLE AS, data, a session setting, a comment, a grant, a rename or a
 * drop. Every node not here, a DO block, a CALL and an EXECUTE among them, may make anything
 */
// lookup-table: statement node to the condition under which it is inert
const INERT: ReadonlyMap<string, Inert> = /* @__PURE__ */ new Map<string, Inert>([
	["AlterEnumStmt", always],
	["AlterSeqStmt", (node) => !freesSequence(node)],
	[
		"AlterTableStmt",
		(node) =>
			node["objtype"] === "OBJECT_TABLE" &&
			(node["cmds"] as Array<{ AlterTableCmd: Node }>).every(({ AlterTableCmd }) =>
				TABLE_COMMANDS.has(String(AlterTableCmd["subtype"])),
			),
	],
	["AlterTSConfigurationStmt", always],
	["CommentStmt", always],
	["CreateEnumStmt", always],
	["CreateSchemaStmt", (node) => node["schemaElts"] === undefined],
	["CreateStmt", always],
	["CreateTableAsStmt", (node) => node["objtype"] === "OBJECT_TABLE"],
	/* CREATE TEXT SEARCH CONFIGURATION, which Atlas compares itself */
	["DefineStmt", (node) => node["kind"] === "OBJECT_TSCONFIGURATION"],
	["DeleteStmt", always],
	["DropStmt", always],
	["GrantStmt", always],
	["IndexStmt", always],
	["InsertStmt", always],
	["LockStmt", always],
	["MergeStmt", always],
	["RenameStmt", always],
	/* a call of a function no history file defines: one it defines is refused at its CREATE */
	["SelectStmt", always],
	["TransactionStmt", always],
	["TruncateStmt", always],
	["UpdateStmt", always],
	["VariableSetStmt", always],
])

/**
 * Whether `files` may make anything the catalog read compares, which a docker:// dev database, Atlas's
 * own container, keeps out of comb's reach: by parse-tree node, read once, any statement INERT does not
 * prove inert counting, one the parser cannot read among them
 */
function makesCompared(files: readonly HistoryFile[]): boolean {
	return files
		.flatMap(({ sql }) => pgRead(sql).statements)
		.some(({ tree }) => {
			if (tree === undefined) return true
			const [type, node] = nodeOf(tree)
			const inert = INERT.get(type)
			return inert === undefined || !inert(node)
		})
}

export { INERT, makesCompared, TABLE_COMMANDS }
