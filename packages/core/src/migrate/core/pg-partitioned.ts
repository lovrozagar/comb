/**
 * The partitioned tables a Postgres history leaves, and each index it names with its table, which rating reads (P18
 * and P19 of r19, and 0005 of r22b, where a DROP INDEX locks its table): Postgres refuses a NOT VALID foreign key on a partitioned table, and a partitioned
 * index has no storage, so its SET TABLESPACE moves nothing. Tables and indexes share one namespace,
 * so each is keyed as a relation; an index is its table's, in its table's schema, and moves with it.
 * Each follows its table's or its own RENAME, SET SCHEMA and DROP.
 */
import { type Facts, flag, keyOf, names, type Node, tableOf, written } from "./pg-nodes.ts"

/** `name` keyed in the schema the relation `table`'s key names, as an index lives in its table's */
function besideTable(table: string, name: string, schema: string): string {
	const parts = table.split(".")
	return keyOf(parts.length > 1 ? [parts[0] as string, name] : [name], schema)
}

/** The table `from` now `to`: its own entry, and each index on it, which stays its own name in the table's schema */
function moveTable(facts: Facts, from: string, to: string): void {
	if (facts.partitioned.delete(from)) facts.partitioned.add(to)
	for (const [index, table] of Array.from(facts.indexes)) {
		if (table !== from) continue
		facts.indexes.delete(index)
		facts.indexes.set(besideTable(to, index.split(".").at(-1) as string, facts.schema), to)
	}
}

/** A table dropped, with each index on it */
function dropTable(facts: Facts, table: string): void {
	facts.partitioned.delete(table)
	for (const [index, on] of Array.from(facts.indexes)) if (on === table) facts.indexes.delete(index)
}

// lookup-table: the object kinds a partitioned table is renamed, moved or dropped as
const TABLES: ReadonlySet<unknown> = /* @__PURE__ */ new Set(["OBJECT_TABLE"])

/** A rename or SET SCHEMA of a table or an index, followed */
function followName(type: string, node: Node, facts: Facts): void {
	const kind = node[type === "RenameStmt" ? "renameType" : "objectType"]
	const rel = node["relation"] as { relname: string; schemaname?: string | undefined } | undefined
	if (rel === undefined) return
	const from = tableOf(rel, facts.schema).key
	if (type === "RenameStmt" && kind === "OBJECT_INDEX") {
		const table = facts.indexes.get(from)
		if (table === undefined) return
		facts.indexes.delete(from)
		facts.indexes.set(besideTable(table, String(node["newname"]), facts.schema), table)
	} else if (TABLES.has(kind)) {
		const to =
			type === "RenameStmt"
				? keyOf(
						rel.schemaname === undefined ? [String(node["newname"])] : [rel.schemaname, String(node["newname"])],
						facts.schema,
					)
				: keyOf([String(node["newschema"]), rel.relname], facts.schema)
		moveTable(facts, from, to)
	}
}

/** A partitioned table made, an index made, either renamed, moved or dropped, followed into `facts` */
function followPartitioned(type: string, node: Node, facts: Facts): void {
	if (type === "CreateStmt" && node["partspec"] !== undefined)
		facts.partitioned.add(tableOf(node["relation"], facts.schema).key)
	else if (type === "IndexStmt" && node["idxname"] !== undefined) {
		const table = tableOf(node["relation"], facts.schema).key
		facts.indexes.set(besideTable(table, String(node["idxname"]), facts.schema), table)
	} else if (type === "RenameStmt" || type === "AlterObjectSchemaStmt") followName(type, node, facts)
	else if (type === "DropStmt" && (node["removeType"] === "OBJECT_TABLE" || node["removeType"] === "OBJECT_INDEX")) {
		for (const object of node["objects"] as Node[]) {
			const key = keyOf(names((object["List"] as Node)["items"]), facts.schema)
			if (node["removeType"] === "OBJECT_TABLE") dropTable(facts, key)
			else facts.indexes.delete(key)
		}
	}
}

/** How an index reaches partitioned `table` without blocking its partitions' writes while it builds */
const indexRoute = (table: string): string =>
	`create it ON ONLY ${table}, then CREATE INDEX CONCURRENTLY on each partition in its own -- atlas:txmode none file, then ALTER INDEX … ATTACH PARTITION each to it`

/**
 * How a primary key or unique constraint reaches partitioned `table` without building its index
 * under the ADD's lock, as pg_dump writes one: ADD on ONLY the table builds nothing and locks no
 * partition, and each partition's key, built concurrently, attaches to it under ACCESS SHARE
 * (.tmp/grunt/p21/areas/pa/pa10/probe2.log)
 */
const keyRoute = (table: string): string =>
	`add it to ONLY ${table}, which builds nothing and locks no partition, then build each partition's unique index with CREATE UNIQUE INDEX CONCURRENTLY in its own -- atlas:txmode none file, add each partition's constraint USING INDEX, then ALTER INDEX … ATTACH PARTITION each to ${table}'s`

/**
 * The recipe for an index on partitioned `table`, which CREATE INDEX CONCURRENTLY refuses there
 * (PA10 of r22b, .tmp/grunt/r22b/migrate-pg-atlas/lock/partitioned-index-recipe.log)
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
		.find((parts) => facts.partitioned.has(facts.indexes.get(keyOf(parts, facts.schema)) ?? ""))
	if (index === undefined) return undefined
	return `Postgres refuses DROP INDEX CONCURRENTLY of partitioned index ${index.join(".")} ("cannot drop partitioned index "${index.at(-1) as string}" concurrently"); drop it without CONCURRENTLY`
}

/**
 * Why Postgres refuses a statement on a table or index `facts` hold partitioned, in a transaction
 * or out of one, with comb's route (PA10 of r22b, .tmp/grunt/p21/areas/pa/pa10/probe.log); undefined
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
