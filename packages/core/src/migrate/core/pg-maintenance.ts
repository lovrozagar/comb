/**
 * The maintenance commands that hold an exclusive lock while they run, read from their parse trees
 * (P7 of the 0.14.1 review), so every spelling Postgres takes is warned of: a VACUUM with FULL on,
 * a REINDEX that is not concurrent, and CLUSTER.
 */
import type { Finding } from "./classify-alter.ts"
import { type Node, nodesOf } from "./pg-nodes.ts"

const LOCKED: Finding = { level: "lock", note: "holds an exclusive lock while it runs" }

/** Whether an option's argument is on, as Postgres reads a boolean: given bare, a nonzero number, or true, on or yes */
function isOn(arg: unknown): boolean {
	if (arg === undefined) return true
	const value = arg as { Integer?: { ival?: number }; String?: { sval: string } }
	if (value.Integer !== undefined) return (value.Integer.ival ?? 0) !== 0
	return /^(?:true|on|yes)$/i.test(value.String?.sval ?? "")
}

/** Whether `options`, a statement's option list, turns `name` on */
const turnsOn = (options: unknown, name: string): boolean =>
	nodesOf(options).some(([type, node]) => type === "DefElem" && node["defname"] === name && isOn(node["arg"]))

/** A maintenance statement's lock finding; undefined for a statement that is none */
function maintenanceFindings(type: string, node: Node): Finding[] | undefined {
	if (type === "VacuumStmt") return turnsOn(node["options"], "full") ? [LOCKED] : []
	if (type === "ReindexStmt") return turnsOn(node["params"], "concurrently") ? [] : [LOCKED]
	return type === "ClusterStmt" ? [LOCKED] : undefined
}

export { maintenanceFindings }
