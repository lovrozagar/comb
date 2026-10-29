/**
 * The maintenance commands that hold an exclusive lock while they run, read from their parse trees
 * (P7 of the 0.14.1 review), so every spelling Postgres takes is warned of: a VACUUM with FULL on,
 * a REINDEX or REFRESH MATERIALIZED VIEW that is not concurrent, CLUSTER, a LOCK that blocks writes, and
 * an ATTACH PARTITION, which scans the partition (P1 of the 0.15.0 review).
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

/** An ATTACH PARTITION's finding: Postgres checks every row of `partition` against its bound under ACCESS EXCLUSIVE */
const attachFindings = (partition: string): Finding[] => [
	{
		level: "lock",
		note: `scans ${partition} under an exclusive lock to check its bound; add a CHECK constraint matching the bound NOT VALID, VALIDATE it, then ATTACH`,
	},
]

/* LOCK's modes as the parser numbers them: SHARE and stronger block writes, ACCESS EXCLUSIVE reads too */
const [SHARE_LOCK, ACCESS_EXCLUSIVE_LOCK] = [5, 8]

/** A LOCK's finding: what its mode blocks, until the file's transaction ends */
function lockFindings(node: Node): Finding[] {
	const mode = Number(node["mode"])
	if (mode < SHARE_LOCK) return []
	const tables = nodesOf(node["relations"]).map(([, rel]) =>
		[rel["schemaname"], rel["relname"]].filter((part) => part !== undefined).join("."),
	)
	const blocks = mode >= ACCESS_EXCLUSIVE_LOCK ? "reads and writes" : "writes"
	return [{ level: "lock", note: `locks ${tables.join(", ")} against ${blocks} until the file's transaction ends` }]
}

/**
 * A maintenance or locking statement's lock finding; undefined for a statement that is none. A
 * REFRESH MATERIALIZED VIEW that is not concurrent holds ACCESS EXCLUSIVE on its view, and a LOCK
 * what its mode takes (P1 of the 0.15.0 review)
 */
function maintenanceFindings(type: string, node: Node): Finding[] | undefined {
	if (type === "VacuumStmt") return turnsOn(node["options"], "full") ? [LOCKED] : []
	if (type === "ReindexStmt") return turnsOn(node["params"], "concurrently") ? [] : [LOCKED]
	if (type === "RefreshMatViewStmt") return node["concurrent"] === true ? [] : [LOCKED]
	if (type === "LockStmt") return lockFindings(node)
	return type === "ClusterStmt" ? [LOCKED] : undefined
}

export { attachFindings, maintenanceFindings }
