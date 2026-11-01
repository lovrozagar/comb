/**
 * The partitioned tables a Postgres history leaves, and the indexes on them, which rating reads (P18
 * and P19 of r19): Postgres refuses a NOT VALID foreign key on a partitioned table, and a partitioned
 * index has no storage, so its SET TABLESPACE moves nothing. Tables and indexes share one namespace,
 * so each is keyed as a relation; an index is its table's, in its table's schema, and moves with it.
 * Each follows its table's or its own RENAME, SET SCHEMA and DROP.
 */
import { type Facts, keyOf, names, type Node, tableOf } from "./pg-nodes.ts"

/** `name` keyed in the schema the relation `table`'s key names, as an index lives in its table's */
function besideTable(table: string, name: string, schema: string): string {
	const parts = table.split(".")
	return keyOf(parts.length > 1 ? [parts[0] as string, name] : [name], schema)
}

/** The table `from` now `to`: its own entry, and each index on it, which stays its own name in the table's schema */
function moveTable(facts: Facts, from: string, to: string): void {
	if (facts.partitioned.delete(from)) facts.partitioned.add(to)
	for (const [index, table] of Array.from(facts.partitionedIndexes)) {
		if (table !== from) continue
		facts.partitionedIndexes.delete(index)
		facts.partitionedIndexes.set(besideTable(to, index.split(".").at(-1) as string, facts.schema), to)
	}
}

/** A table dropped, with each index on it */
function dropTable(facts: Facts, table: string): void {
	facts.partitioned.delete(table)
	for (const [index, on] of Array.from(facts.partitionedIndexes))
		if (on === table) facts.partitionedIndexes.delete(index)
}

// lookup-table: the object kinds a partitioned table is renamed, moved or dropped as
const TABLES: ReadonlySet<unknown> = /* @__PURE__ */ new Set(["OBJECT_TABLE"])

/** A rename or SET SCHEMA of a table or an index, followed */
function followName(type: string, node: Node, facts: Facts): void {
	const kind = node[type === "RenameStmt" ? "renameType" : "objectType"]
	const rel = node["relation"] as { relname: string; schemaname?: string } | undefined
	if (rel === undefined) return
	const from = tableOf(rel, facts.schema).key
	if (type === "RenameStmt" && kind === "OBJECT_INDEX") {
		const table = facts.partitionedIndexes.get(from)
		if (table === undefined) return
		facts.partitionedIndexes.delete(from)
		facts.partitionedIndexes.set(besideTable(table, String(node["newname"]), facts.schema), table)
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

/** A partitioned table made, an index made on one, either renamed, moved or dropped, followed into `facts` */
function followPartitioned(type: string, node: Node, facts: Facts): void {
	if (type === "CreateStmt" && node["partspec"] !== undefined)
		facts.partitioned.add(tableOf(node["relation"], facts.schema).key)
	else if (type === "IndexStmt" && node["idxname"] !== undefined) {
		const table = tableOf(node["relation"], facts.schema).key
		if (facts.partitioned.has(table))
			facts.partitionedIndexes.set(besideTable(table, String(node["idxname"]), facts.schema), table)
	} else if (type === "RenameStmt" || type === "AlterObjectSchemaStmt") followName(type, node, facts)
	else if (type === "DropStmt" && (node["removeType"] === "OBJECT_TABLE" || node["removeType"] === "OBJECT_INDEX")) {
		for (const object of node["objects"] as Node[]) {
			const key = keyOf(names((object["List"] as Node)["items"]), facts.schema)
			if (node["removeType"] === "OBJECT_TABLE") dropTable(facts, key)
			else facts.partitionedIndexes.delete(key)
		}
	}
}

export { followPartitioned }
