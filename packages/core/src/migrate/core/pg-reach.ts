/**
 * What a Postgres write reaches beyond the table it names (pg-tree.ts): the rows it routes to a
 * partition or writes in an inheritance child, unless the statement names ONLY that table, and the
 * code each table it reaches runs: its triggers (a partitioned parent's are cloned onto every
 * partition) and the code its history attached (pg-history.ts). Also what a use of a migration's
 * operator or cast runs, and the tables a file stops filling fresh once an existing table becomes
 * a child of one.
 */
import type { ExtractedSchema } from "../types.ts"
import type { Finding } from "./classify-alter.ts"
import type { Fresh } from "./classify-write.ts"
import { type Facts, keyOf, names, tableOf, typeOf } from "./pg-history.ts"

type Node = Record<string, unknown>

/** The tables a write to `table` reaches: itself, its descendants unless ONLY, and the partitions' parents */
function reached(table: string, inh: boolean, facts: Facts): string[] {
	const out = [table]
	for (let i = 0; i < out.length; i++) {
		const at = out[i] as string
		for (const [child, parents] of facts.parents)
			if (inh && parents.some(({ parent }) => parent === at) && !out.includes(child)) out.push(child)
		/* a partitioned parent's row triggers are cloned onto each partition */
		for (const { parent, partition } of facts.parents.get(at) ?? [])
			if (partition && !out.includes(parent)) out.push(parent)
	}
	return out
}

/** What a write to `table` runs, for any of `events`: each trigger and each attached code of every table it reaches */
function reachFindings(
	table: { inh: boolean; key: string },
	events: readonly string[],
	ctx: { before?: ExtractedSchema | undefined; facts: Facts },
): Finding[] {
	return reached(table.key, table.inh, ctx.facts).flatMap((key) => [
		...(ctx.facts.triggers.get(key) ?? [])
			.filter((trigger) => trigger.events.some((event) => events.includes(event)))
			.map((trigger) => ({
				level: "unsafe" as const,
				note: `fires trigger ${trigger.name}, whose body runs for every row it writes`,
			})),
		...(ctx.facts.code.has(key)
			? [{ level: "unsafe" as const, note: `runs ${ctx.facts.code.get(key) as string} on every write to ${key}` }]
			: []),
	])
}

/** A use of a migration's operator, or a cast to a type a migration's cast reaches: its finding */
function useFinding(type: string, node: Node, facts: Facts): Finding | undefined {
	if (type === "A_Expr" && Array.isArray(node["name"])) {
		const operator = keyOf(names(node["name"]), facts.schema)
		/* a bare operator resolves through the search path, so it may be a migration's in any schema */
		const fn =
			facts.operators.get(operator) ??
			(operator.includes(".")
				? undefined
				: [...facts.operators].find(([key]) => key.split(".").at(-1) === operator)?.[1])
		if (fn !== undefined)
			return { level: "unsafe", note: `uses operator ${operator}, which a migration defined (${fn})` }
	}
	if (type === "TypeCast") {
		const target = typeOf(node["typeName"], facts.schema)
		const cast = facts.casts.get(target)
		if (cast !== undefined)
			return { level: "unsafe", note: `casts to ${target} through ${cast.fn}, which a migration defined` }
	}
	return undefined
}

/**
 * `fresh` after an ALTER TABLE: a table the file did not create made a partition or an inheritance
 * child of a fresh table puts its rows under it, so the parent is fresh no longer; keyed under `schema`
 */
function followParentage(node: Node, fresh: Fresh, schema: string): void {
	const relation = tableOf(node["relation"], schema).key
	for (const each of node["cmds"] as Node[]) {
		const cmd = each["AlterTableCmd"] as Node
		const def = cmd["def"] as Node
		const [child, parent] =
			cmd["subtype"] === "AT_AttachPartition"
				? [tableOf((def["PartitionCmd"] as Node)["name"], schema).key, relation]
				: cmd["subtype"] === "AT_AddInherit"
					? [relation, tableOf(def["RangeVar"], schema).key]
					: []
		if (child === undefined || parent === undefined || fresh.tables.has(child)) continue
		fresh.tables.delete(parent)
		fresh.columns.delete(parent)
	}
}

export { followParentage, reachFindings, useFinding }
