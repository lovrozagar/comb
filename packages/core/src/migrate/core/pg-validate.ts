/**
 * A VALIDATE CONSTRAINT in a transaction that holds a lock another session waits on (PA8 of r22b, and
 * 0005, its class). A VALIDATE alone holds only SHARE UPDATE EXCLUSIVE, but every lock an earlier
 * statement of the file took lasts to its COMMIT (pg-held.ts): a NOT VALID ADD's, an ADD COLUMN's, an
 * index build's among them. A VALIDATE before that COMMIT scans every row under those locks, which is
 * what the NOT VALID recipe exists to avoid. Probed on Postgres 17
 * (.tmp/grunt/r22b/lock/notvalid-same-file.ts, tests/integration/postgres/lock-oracle-held.test.ts).
 */
import type { Finding } from "./classify-alter.ts"
import { alterLocks, type Held, hold } from "./pg-held.ts"
import { type Facts, type Node, tableOf, written } from "./pg-nodes.ts"

/** "a", "a and b", "a, b and c" */
function listed(names: readonly string[]): string {
	return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) as string}`
}

/** What `locks` block, the table scanned keyed `key`: "it locked against …" when they hold only that */
function holding(locks: ReadonlyMap<string, boolean>, key: string): string {
	const scanned = locks.get(key)
	if (locks.size === 1 && scanned !== undefined) return `it locked against ${scanned ? "reads and writes" : "writes"}`
	const sorted = [...locks.keys()].toSorted()
	const reads = sorted.filter((name) => locks.get(name) === true)
	const writes = sorted.filter((name) => locks.get(name) === false)
	const groups = [
		...(reads.length > 0 ? [`${listed(reads)} locked against reads and writes`] : []),
		...(writes.length > 0 ? [`${listed(writes)}${reads.length > 0 ? "" : " locked"} against writes`] : []),
	]
	return groups.join(", and ")
}

/**
 * An ALTER's VALIDATE that scans while the open transaction holds a blocking lock, its commands'
 * locks then held, command by command, so an ADD and a VALIDATE in one statement count
 */
function heldScans(node: Node, { facts, held }: { facts: Facts; held: Held }): Finding[] {
	const table = written(node["relation"])
	return (node["cmds"] as Node[]).flatMap((each): Finding[] => {
		const cmd = each["AlterTableCmd"] as Node
		const scans = node["objtype"] === "OBJECT_TABLE" && cmd["subtype"] === "AT_ValidateConstraint"
		const found: Finding[] =
			scans && held.locks.size > 0
				? [
						{
							level: "lock",
							note: `scans ${table} while this file holds ${holding(held.locks, tableOf(node["relation"], facts.schema).key)}; those locks last to the file's COMMIT; validate in a later file`,
						},
					]
				: []
		hold(held, alterLocks(node, cmd, facts))
		return found
	})
}

export { heldScans }
