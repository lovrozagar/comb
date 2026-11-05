/**
 * A VALIDATE CONSTRAINT in the transaction of a NOT VALID ADD (PA8 of r22b). The ADD skips the scan,
 * but its lock lasts to COMMIT: ACCESS EXCLUSIVE on its table for a CHECK, which blocks reads, and
 * SHARE ROW EXCLUSIVE on its table and the one it references for a foreign key, which blocks writes.
 * A VALIDATE before that COMMIT scans every row under the ADD's lock, which is what the recipe exists
 * to avoid; in a later transaction it holds only SHARE UPDATE EXCLUSIVE. Probed on Postgres 17
 * (.tmp/grunt/r22b/lock/notvalid-same-file.ts).
 */
import type { Finding } from "./classify-alter.ts"
import { type Facts, type Node, tableOf, written } from "./pg-nodes.ts"

/** The tables the open transaction holds locked since its NOT VALID ADDs, by key: each as written, and whether reads wait too */
type Held = Map<string, { name: string; reads: boolean }>

/** What heldScans reads and follows: the history's schema, and the locks the open transaction holds */
type HeldContext = { facts: Facts; held: Held }

/** `held` with `relation` locked, against reads too when `reads` */
function hold({ facts, held }: HeldContext, relation: unknown, reads: boolean): void {
	const { key } = tableOf(relation, facts.schema)
	held.set(key, { name: written(relation), reads: reads || held.get(key)?.reads === true })
}

/** "a", "a and b", "a, b and c" */
function listed(names: readonly string[]): string {
	return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) as string}`
}

/** What `held` blocks, the table scanned keyed `key`: "it locked against …" when it holds only that */
function holding(held: Held, key: string): string {
	const scanned = held.get(key)
	if (held.size === 1 && scanned !== undefined)
		return `it locked against ${scanned.reads ? "reads and writes" : "writes"}`
	const all = [...held.values()]
	const reads = all.filter((each) => each.reads).map((each) => each.name)
	const writes = all.filter((each) => !each.reads).map((each) => each.name)
	const groups = [
		...(reads.length > 0 ? [`${listed(reads)} locked against reads and writes`] : []),
		...(writes.length > 0 ? [`${listed(writes)}${reads.length > 0 ? "" : " locked"} against writes`] : []),
	]
	return groups.join(", and ")
}

/**
 * An ALTER TABLE's VALIDATE scans while the open transaction holds a NOT VALID ADD's lock, command
 * by command, so an ADD and a VALIDATE in one statement count
 */
function heldScans(node: Node, ctx: HeldContext): Finding[] {
	const { facts, held } = ctx
	if (node["objtype"] !== "OBJECT_TABLE") return []
	const table = written(node["relation"])
	return (node["cmds"] as Node[]).flatMap((each): Finding[] => {
		const cmd = each["AlterTableCmd"] as Node
		if (cmd["subtype"] === "AT_ValidateConstraint" && held.size > 0) {
			const note = `scans ${table} while this file holds ${holding(held, tableOf(node["relation"], facts.schema).key)}; the ADD's lock is held through this scan; validate in a later file`
			return [{ level: "lock", note }]
		}
		const constraint = (cmd["def"] as Node | undefined)?.["Constraint"] as Node | undefined
		if (cmd["subtype"] !== "AT_AddConstraint" || constraint?.["skip_validation"] !== true) return []
		const check = constraint["contype"] === "CONSTR_CHECK"
		hold(ctx, node["relation"], check)
		if (!check) hold(ctx, constraint["pktable"], false)
		return []
	})
}

export { type Held, heldScans }
