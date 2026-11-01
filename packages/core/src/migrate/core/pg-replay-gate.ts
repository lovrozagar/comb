/**
 * Whether a Postgres history makes anything baseline's catalog read compares (pg-live-catalog.ts), the
 * gate a docker:// dev database is held to: Atlas's own container, which comb cannot reach, so a history
 * that makes any such object is refused naming devUrl (P5 of r19), and one that makes none needs no replay.
 */
import { type HistoryFile, nodeOf } from "./pg-replay.ts"
import { pgRead } from "./pg-split.ts"

type Node = Record<string, unknown>

/** Whether a statement's node makes what a catalog arm reads */
type Makes = (node: Node) => boolean

const always: Makes = () => true

/**
 * Each arm of the catalog read (pg-live-catalog.ts), by its `what`, with the statement nodes that make
 * what it reads, held to the read's arms by a structure test so an arm cannot be added without its
 * gate (R1 of plan 18's stack 2). `user` is the role the read connects as, which nothing makes. A
 * sequence a column owns (serial, identity) is the table's, left out of the read, so no arm needs it
 */
// lookup-table: catalog arm to the nodes that make what it reads
const ARM_MAKERS: Readonly<Record<string, Readonly<Record<string, Makes>>>> = {
	extension: { CreateExtensionStmt: always },
	kind: {
		CompositeTypeStmt: always,
		CreateDomainStmt: always,
		CreateRangeStmt: always,
		/* CREATE COLLATION is a DefineStmt of kind OBJECT_COLLATION in the parser's tree */
		DefineStmt: (node) => node["kind"] === "OBJECT_COLLATION",
	},
	policy: { CreatePolicyStmt: always },
	relation: {
		CreateSeqStmt: always,
		CreateTableAsStmt: (node) => node["objtype"] === "OBJECT_MATVIEW",
		ViewStmt: always,
	},
	rls: {
		AlterTableStmt: (node) =>
			(node["cmds"] as Array<{ AlterTableCmd: Node }>).some(({ AlterTableCmd }) =>
				String(AlterTableCmd["subtype"]).endsWith("RowSecurity"),
			),
	},
	/* P12 of r19: aggregates, SECURITY DEFINER, operators, casts, view options, matview indexes, replica identity */
	other: {
		AlterFunctionStmt: always,
		/* a replica identity on any table; options on a view or matview, as a table's own Atlas compares */
		AlterTableStmt: (node) =>
			(node["cmds"] as Array<{ AlterTableCmd: Node }>).some(({ AlterTableCmd }) => {
				const subtype = String(AlterTableCmd["subtype"])
				return (
					subtype === "AT_ReplicaIdentity" || (subtype === "AT_SetRelOptions" && node["objtype"] !== "OBJECT_TABLE")
				)
			}),
		CreateCastStmt: always,
		DefineStmt: (node) => node["kind"] === "OBJECT_AGGREGATE" || node["kind"] === "OBJECT_OPERATOR",
	},
	/* database-wide, which a platform may hold of its own */
	platform: { CreateEventTrigStmt: always, CreatePublicationStmt: always },
	routine: { CreateFunctionStmt: always },
	rule: { RuleStmt: always },
	trigger: { CreateTrigStmt: always },
}

/**
 * The statements whose effect the tree cannot see, which may make anything (R1 of stack 2): a DO
 * block, a procedure CALL, a prepared statement's EXECUTE
 */
// lookup-table: the node types counted as making something compared, whatever they hold
const UNSEEN: ReadonlySet<string> = /* @__PURE__ */ new Set(["CallStmt", "DoStmt", "ExecuteStmt"])

/**
 * Whether `files` make anything the catalog read compares, which a docker:// dev database, Atlas's
 * own container, keeps out of comb's reach: by parse-tree node, read once. A statement the tree cannot
 * see the effect of counts; a function the history defines, which a later call may run DDL through, is
 * itself compared, so its CREATE already counts
 */
function makesCompared(files: readonly HistoryFile[]): boolean {
	const trees = files.flatMap(({ sql }) =>
		pgRead(sql).statements.flatMap(({ tree }) => (tree === undefined ? [] : [tree])),
	)
	return trees.some((tree) => {
		const [type, node] = nodeOf(tree)
		return UNSEEN.has(type) || Object.values(ARM_MAKERS).some((makers) => makers[type]?.(node) === true)
	})
}

export { ARM_MAKERS, makesCompared, UNSEEN }
