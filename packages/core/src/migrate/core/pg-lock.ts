/**
 * How a Postgres statement locks a relation (0005 of r22b, pg-held.ts holds what a file holds): ACCESS
 * EXCLUSIVE, which blocks reads and writes, or SHARE and the like, which block writes, on the relation
 * alone or through its descendants too, and the locks a change reaches through the foreign keys of
 * its table (pg-foreign.ts), on tables the statement does not name.
 */
import { type Change, keyReach, partitionReach, truncated } from "./pg-foreign.ts"
import { type Facts, type Node, tableOf } from "./pg-nodes.ts"

/** A lock a statement takes: the relation's key, and whether reads wait too */
type Lock = readonly [key: string, reads: boolean]

/** Every table under `key`, its partitions and inheritance children, theirs with them */
function descendants(key: string, facts: Facts, out = new Set<string>()): Set<string> {
	for (const [child, parents] of facts.parents)
		if (!out.has(child) && parents.some((each) => each.parent === key)) {
			out.add(child)
			descendants(child, facts, out)
		}
	return out
}

/** How a statement locks a relation: whether reads wait too, and whether its descendants are locked with it */
type Mode = { reads: boolean; recurse: boolean }

/* ACCESS EXCLUSIVE, and SHARE or the like, on a relation alone or with its descendants */
const EXCLUSIVE: Mode = { reads: true, recurse: false }
const EXCLUSIVE_ALL: Mode = { reads: true, recurse: true }
const SHARE: Mode = { reads: false, recurse: false }
const SHARE_ALL: Mode = { reads: false, recurse: true }

/** The lock on `key`, as `mode` takes it */
const keyLocks = (key: string, { reads, recurse }: Mode, facts: Facts): Lock[] => [
	[key, reads],
	...[...(recurse ? descendants(key, facts) : [])].map((child): Lock => [child, reads]),
]

/** The lock on a RangeVar's relation, as `mode` takes it, its descendants left out when it is named ONLY; none on a temporary one */
function on(relation: unknown, facts: Facts, mode: Mode): Lock[] {
	const { key, temp } = tableOf(relation, facts.schema)
	return temp ? [] : keyLocks(key, { ...mode, recurse: mode.recurse && (relation as Node)["inh"] === true }, facts)
}

/** The lock on the DEFAULT partition of a RangeVar's partitioned table, which a new bound is checked against */
function defaultOf(relation: unknown, facts: Facts): Lock[] {
	const partition = facts.defaultPartitions.get(tableOf(relation, facts.schema).key)
	return partition === undefined ? [] : [[partition, true]]
}

/**
 * The locks a change to the table keyed `table` takes through its keys: ACCESS EXCLUSIVE on each
 * table a key it drops or rebuilds references, and on each table, with its descendants, whose key to it goes
 */
function reachLocks(table: string, change: Change, facts: Facts): Lock[] {
	const { referenced, referencing } = keyReach(table, change, facts)
	return [
		...referenced.map((key): Lock => [key, true]),
		...referencing.flatMap((key) => keyLocks(key, EXCLUSIVE_ALL, facts)),
	]
}

/** The locks a partition made, attached or detached under `parent` takes: SHARE ROW EXCLUSIVE on each table its parent's keys reference */
const partitionLocks = (parent: unknown, facts: Facts): Lock[] =>
	partitionReach(tableOf(parent, facts.schema).key, facts).map((key): Lock => [key, false])

/** What an ALTER TABLE command changes of its table's keys: a constraint or column dropped, a column retyped */
function changeOf(cmd: Node): Change | undefined {
	const [cascade, name] = [cmd["behavior"] === "DROP_CASCADE", String(cmd["name"])]
	if (cmd["subtype"] === "AT_DropConstraint") return { cascade, kind: "constraint", name }
	if (cmd["subtype"] === "AT_DropColumn") return { cascade, kind: "column", name }
	return cmd["subtype"] === "AT_AlterColumnType" ? { kind: "retype", name } : undefined
}

/** The locks an ALTER TABLE command takes through its table's keys, none on a temporary table */
function changeLocks(relation: unknown, cmd: Node, facts: Facts): Lock[] {
	const change = changeOf(cmd)
	const { key, temp } = tableOf(relation, facts.schema)
	return change === undefined || temp ? [] : reachLocks(key, change, facts)
}

/** The locks a TRUNCATE takes: its tables', and under CASCADE each table, with its descendants, whose keys reach them */
function truncateLocks(node: Node, facts: Facts): Lock[] {
	const named = (node["relations"] as Array<{ RangeVar: Node }>).flatMap((each) =>
		on(each.RangeVar, facts, EXCLUSIVE_ALL),
	)
	if (node["behavior"] !== "DROP_CASCADE") return named
	const within = (key: string): string[] => [key, ...descendants(key, facts)]
	const reached = truncated(
		named.map(([key]) => key),
		facts,
		within,
	)
	return [...named, ...reached.map((key): Lock => [key, true])]
}

export {
	changeLocks,
	defaultOf,
	EXCLUSIVE,
	EXCLUSIVE_ALL,
	keyLocks,
	type Lock,
	on,
	partitionLocks,
	reachLocks,
	SHARE,
	SHARE_ALL,
	truncateLocks,
}
