/**
 * The maintenance commands that hold an exclusive lock while they run, read from their parse trees
 * (P7 of the 0.14.1 review), so every spelling Postgres takes is warned of: a VACUUM with FULL on,
 * a REINDEX or REFRESH MATERIALIZED VIEW that is not concurrent, CLUSTER, a LOCK that blocks writes, and
 * an ATTACH PARTITION, which scans the partition (P1 of the 0.15.0 review).
 */
import type { Finding } from "./classify-alter.ts"
import { type Facts, type Node, nodesOf, tableOf } from "./pg-nodes.ts"

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

/**
 * An ATTACH PARTITION's finding: Postgres checks every row of `partition` against its bound under
 * ACCESS EXCLUSIVE, and every row of the parent's default partition, when it has one, against the
 * bound too (P12 of r18); a default partition's rows against every other bound (P20 of r19). `defaulted`
 * names the parent's default partition, or is "default" when `partition` attaches as it
 */
function attachFindings(partition: string, defaulted?: string): Finding[] {
	return [{ level: "lock", note: attachNote(partition, defaulted) }]
}

/** What an ATTACH of `partition` scans, and how to have it scan nothing; `defaulted` is "default" when it attaches as the default */
function attachNote(partition: string, defaulted: string | undefined): string {
	/* a default partition has no bound: Postgres checks that no row of it falls in another partition's (P20 of r19) */
	if (defaulted === "default")
		return `scans ${partition} under an exclusive lock for rows another partition's bound takes; add a CHECK constraint to ${partition} that excludes every other partition's bound NOT VALID, VALIDATE it, then ATTACH`
	if (defaulted === undefined)
		return `scans ${partition} under an exclusive lock to check its bound; add a CHECK constraint matching the bound NOT VALID, VALIDATE it, then ATTACH`
	return `scans ${partition}, and the default partition ${defaulted}, under an exclusive lock to check their bounds; add a CHECK constraint matching the bound to ${partition} and one excluding it to ${defaulted}, each NOT VALID, VALIDATE them, then ATTACH`
}

/** A partition created beside its parent's default partition: Postgres checks no row of the default belongs to it */
function createFindings(node: Node, facts: Facts): Finding[] {
	const bound = node["partbound"] as Node | undefined
	const [parent] = ((node["inhRelations"] as Node[] | undefined) ?? []).map(
		(each) => tableOf(each["RangeVar"], facts.schema).key,
	)
	const defaulted = parent === undefined ? undefined : facts.defaultPartitions.get(parent)
	if (bound === undefined || bound["is_default"] === true || defaulted === undefined) return []
	const table = tableOf(node["relation"], facts.schema).key
	return [
		{
			level: "lock",
			note: `scans the default partition ${defaulted} under an exclusive lock to check no row of it belongs to ${table}; add a CHECK constraint excluding the new bound to ${defaulted} NOT VALID, VALIDATE it, then create the partition`,
		},
	]
}

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

/* a PREPARE's finding: what it holds runs only when an EXECUTE runs it */
const PREPARES: Finding = {
	level: "cautious",
	note: "prepares a statement for an EXECUTE, which comb rates by the statement it runs",
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
	/* a PREPARE runs nothing itself: the EXECUTE that runs it is rated by what it runs (P21 of r19) */
	if (type === "PrepareStmt") return [PREPARES]
	return type === "ClusterStmt" ? [LOCKED] : undefined
}

export { attachFindings, createFindings, maintenanceFindings }
