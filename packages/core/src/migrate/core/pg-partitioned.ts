/**
 * The partitioned tables a Postgres history leaves, which rating reads, each
 * followed through its RENAME, SET SCHEMA and DROP, and the statements Postgres refuses on one, with
 * comb's route around each: Postgres refuses a NOT VALID foreign key on a partitioned table, and
 * CREATE INDEX CONCURRENTLY, ADD … USING INDEX and DROP INDEX CONCURRENTLY of a partitioned index.
 * Its indexes are pg-indexes.ts's.
 */
import { lineage } from "./pg-index-facts.ts"
import { type Facts, flag, keyOf, names, type Node, tableOf, written } from "./pg-nodes.ts"

/** A partitioned table made, renamed, moved or dropped, followed into `facts`; a table dropped takes its partitions */
function followPartitioned(type: string, node: Node, facts: Facts): void {
	if (type === "CreateStmt" && node["partspec"] !== undefined)
		facts.partitioned.add(tableOf(node["relation"], facts.schema).key)
	else if ((type === "RenameStmt" || type === "AlterObjectSchemaStmt") && node["relation"] !== undefined) {
		if (node[type === "RenameStmt" ? "renameType" : "objectType"] !== "OBJECT_TABLE") return
		const rel = node["relation"] as { relname: string; schemaname?: string | undefined }
		const to =
			type === "RenameStmt"
				? keyOf(
						rel.schemaname === undefined ? [String(node["newname"])] : [rel.schemaname, String(node["newname"])],
						facts.schema,
					)
				: keyOf([String(node["newschema"]), rel.relname], facts.schema)
		if (facts.partitioned.delete(tableOf(rel, facts.schema).key)) facts.partitioned.add(to)
	} else if (type === "DropStmt" && node["removeType"] === "OBJECT_TABLE")
		for (const object of node["objects"] as Node[])
			for (const table of lineage(facts, keyOf(names((object["List"] as Node)["items"]), facts.schema)))
				facts.partitioned.delete(table)
}

/** How an index reaches partitioned `table` without blocking its partitions' writes while it builds */
const indexRoute = (table: string): string =>
	`create it ON ONLY ${table}, then CREATE INDEX CONCURRENTLY on each partition in its own -- atlas:txmode none file, then ALTER INDEX … ATTACH PARTITION each to it`

/**
 * How a primary key or unique constraint reaches partitioned `table` without building its index
 * under the ADD's lock, as pg_dump writes one: ADD on ONLY the table builds nothing and locks no
 * partition, and each partition's key, built concurrently, attaches to it under ACCESS SHARE
 */
const keyRoute = (table: string): string =>
	`add it to ONLY ${table}, which builds nothing and locks no partition, then build each partition's unique index with CREATE UNIQUE INDEX CONCURRENTLY in its own -- atlas:txmode none file, add each partition's constraint USING INDEX, then ALTER INDEX … ATTACH PARTITION each to ${table}'s`

/**
 * The recipe for an index on partitioned `table`, which CREATE INDEX CONCURRENTLY refuses there
 */
const partitionedRecipe = (table: string): string =>
	`${table} is partitioned, which CREATE INDEX CONCURRENTLY refuses: ${indexRoute(table)}`

/** The recipe for a primary key or unique constraint on partitioned `table`, which ADD … USING INDEX refuses, after `first` */
const partitionedKeyRecipe = (table: string, first: string): string =>
	`${table} is partitioned, which ADD … USING INDEX refuses: ${first}${keyRoute(table)}`

/** Whether an ALTER TABLE command adds a constraint USING INDEX */
const usingIndex = (each: Node): boolean => {
	const cmd = each["AlterTableCmd"] as Node
	return (
		cmd["subtype"] === "AT_AddConstraint" && ((cmd["def"] as Node)["Constraint"] as Node)["indexname"] !== undefined
	)
}

/** Why Postgres refuses DROP INDEX CONCURRENTLY `node` of an index `facts` hold partitioned; undefined for one it runs */
function dropRefusal(node: Node, facts: Facts): string | undefined {
	const index = (node["objects"] as Node[])
		.map((object) => names((object["List"] as Node)["items"]))
		.find((parts) => facts.partitioned.has(facts.indexes.get(keyOf(parts, facts.schema))?.table ?? ""))
	if (index === undefined) return undefined
	return `Postgres refuses DROP INDEX CONCURRENTLY of partitioned index ${index.join(".")} ("cannot drop partitioned index "${index.at(-1) as string}" concurrently"); drop it without CONCURRENTLY`
}

/**
 * Why Postgres refuses a statement on a table or index `facts` hold partitioned, in a transaction
 * or out of one, with comb's route; undefined
 * for one it runs
 */
function partitionedRefusal(type: string, node: Node, facts: Facts): string | undefined {
	if (type === "DropStmt")
		return node["removeType"] === "OBJECT_INDEX" && flag(node["concurrent"]) ? dropRefusal(node, facts) : undefined
	if (type !== "IndexStmt" && type !== "AlterTableStmt") return undefined
	const { key, name } = tableOf(node["relation"], facts.schema)
	if (!facts.partitioned.has(key)) return undefined
	const table = written(node["relation"])
	if (type === "IndexStmt")
		return flag(node["concurrent"])
			? `Postgres refuses CREATE INDEX CONCURRENTLY on partitioned ${table} ("cannot create index on partitioned table "${name}" concurrently"); ${indexRoute(table)}`
			: undefined
	return (node["cmds"] as Node[]).some(usingIndex)
		? `Postgres refuses ADD … USING INDEX on partitioned ${table} ("ALTER TABLE / ADD CONSTRAINT USING INDEX is not supported on partitioned tables"); ${keyRoute(table)}`
		: undefined
}

export { followPartitioned, partitionedKeyRecipe, partitionedRecipe, partitionedRefusal }
