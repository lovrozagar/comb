/**
 * An added column read from its type and inline constraints, as the matching ALTER TABLE commands
 * are (P6 of the 0.14.1 review): NOT NULL with nothing to fill it fails on a table with rows, and so
 * does a primary key unless each row gets a value of its own; a volatile default, a serial, an
 * identity or a stored generated column fills every row, which rewrites the table, and an inline
 * check or reference scans it.
 */
import type { Finding } from "./classify-alter.ts"
import { names, type Node, nodesOf } from "./pg-nodes.ts"

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

// lookup-table: the serial types, each a sequence's nextval() as the column's default
const SERIALS = /* @__PURE__ */ new Set(["bigserial", "serial", "serial2", "serial4", "serial8", "smallserial"])

/** The inline constraints of the column an AT_AddColumn command adds */
const inlineConstraints = (cmd: Node): Node[] =>
	((((cmd["def"] as Node)["ColumnDef"] as Node)["constraints"] as Node[] | undefined) ?? []).map(
		(each) => each["Constraint"] as Node,
	)

/** An added column's findings, from the AT_AddColumn command `cmd` */
function addColumn(cmd: Node): Finding[] {
	const column = (cmd["def"] as Node)["ColumnDef"] as Node
	const constraints = inlineConstraints(cmd)
	const has = (type: string) => constraints.some((each) => each["contype"] === type)
	const defaults = constraints.filter((each) => each["contype"] === "CONSTR_DEFAULT")
	const volatile = nodesOf(defaults.map((each) => each["raw_expr"])).some(
		([type, node]) => type === "FuncCall" && VOLATILE.has(names(node["funcname"]).at(-1) as string),
	)
	const serial = SERIALS.has(names((column["typeName"] as Node)["names"]).at(-1) as string)
	/* a sequence, an identity or a volatile default gives each row a value of its own */
	const distinct = serial || volatile || has("CONSTR_IDENTITY")
	const filled = distinct || has("CONSTR_DEFAULT") || has("CONSTR_GENERATED")
	const scans = has("CONSTR_CHECK") || has("CONSTR_FOREIGN")
	const findings: Finding[] = []
	if ((has("CONSTR_NOTNULL") && !filled) || (has("CONSTR_PRIMARY") && !distinct)) findings.push({ level: "unsafe" })
	if (distinct || has("CONSTR_GENERATED") || scans) findings.push({ level: "lock", note: REWRITES })
	return findings
}

export { addColumn, inlineConstraints, REWRITES }
