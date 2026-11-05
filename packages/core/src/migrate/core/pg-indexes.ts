/**
 * Every index a Postgres history leaves, under the name Postgres gives it, which
 * rating reads: a partitioned index has no storage, so its REINDEX refuses a transaction and its SET
 * TABLESPACE moves nothing, and a DROP INDEX locks its table. An index the history does not name
 * takes the name ChooseIndexName chooses (pg-index-facts.ts). An index on a partitioned table reaches each partition,
 * attached to a matching index of the partition's own or cloned onto it, as DefineIndex, CREATE
 * TABLE … PARTITION OF and ATTACH PARTITION do, and a drop of the parent takes its clones. Each
 * follows its own and its table's renames, moves and drops, a constraint's RENAME, and a column's
 * RENAME and DROP (Postgres 17's indexcmds.c, parse_utilcmd.c and tablecmds.c, held to Postgres by
 * tests/integration/postgres/index-names-oracle.test.ts).
 */
import {
	besideTable,
	clone,
	constraintWanted,
	dropIndex,
	indexesOn,
	type IndexShape,
	indexWanted,
	lineage,
	list,
	make,
	merged,
	rekey,
	same,
	taken,
} from "./pg-index-facts.ts"
import { type Facts, flag, keyOf, names, type Node, tableOf } from "./pg-nodes.ts"

/** The columns an index reads: its keys', its expressions' and its predicate's, and its INCLUDE columns */
function uses(shape: IndexShape): Set<string> {
	const out = new Set([
		...shape.elements.flatMap((each) => (each.name === undefined ? [] : [each.name])),
		...shape.include,
	])
	JSON.stringify([shape.elements.map((each) => each.expr), shape.where], (key, value) => {
		if (key === "ColumnRef") out.add(list((value as Node)["fields"]).at(-1) as string)
		return value
	})
	return out
}

/** A column read by an expression or predicate under `tree` renamed */
function renameRefs(tree: unknown, [was, now]: [string, string]): unknown {
	return (
		JSON.parse(JSON.stringify(tree ?? null), (key, value) => {
			if (key !== "ColumnRef") return value
			const fields = (value as Node)["fields"] as Array<{ String?: { sval: string } | undefined }>
			const last = fields.at(-1)?.String
			if (last?.sval === was) last.sval = now
			return value
		}) ?? undefined
	)
}

/** A column of `table` renamed in each index on it and on its partitions, which keep their own names */
function renameColumn(facts: Facts, table: string, renamed: [string, string]): void {
	const tables = lineage(facts, table)
	for (const fact of facts.indexes.values()) {
		if (!tables.includes(fact.table)) continue
		const { shape } = fact
		for (const each of shape.elements) {
			if (each.name === renamed[0]) each.name = renamed[1]
			each.expr = renameRefs(each.expr, renamed)
		}
		shape.include = shape.include.map((name) => (name === renamed[0] ? renamed[1] : name))
		shape.where = renameRefs(shape.where, renamed)
	}
}

/** The key a RENAME or SET SCHEMA gives the relation `rel` */
function movedTo(type: string, node: Node, facts: Facts): string {
	const rel = node["relation"] as { relname: string; schemaname?: string | undefined }
	const newname = String(node["newname"])
	if (type === "RenameStmt")
		return keyOf(rel.schemaname === undefined ? [newname] : [rel.schemaname, newname], facts.schema)
	return keyOf([String(node["newschema"]), rel.relname], facts.schema)
}

/** A RENAME of an index, a table, a constraint or a column, or a table's SET SCHEMA, followed */
function followName(type: string, node: Node, facts: Facts): void {
	const kind = node[type === "RenameStmt" ? "renameType" : "objectType"]
	if (node["relation"] === undefined) return
	const from = tableOf(node["relation"], facts.schema).key
	const index = facts.indexes.get(from)
	if (type === "RenameStmt" && index !== undefined && (kind === "OBJECT_INDEX" || kind === "OBJECT_TABLE"))
		rekey(facts, from, besideTable(index.table, String(node["newname"]), facts.schema))
	else if (kind === "OBJECT_TABLE") {
		const to = movedTo(type, node, facts)
		for (const [key, fact] of Array.from(facts.indexes)) {
			if (fact.table !== from) continue
			fact.table = to
			rekey(facts, key, besideTable(to, key.split(".").at(-1) as string, facts.schema))
		}
	} else if (kind === "OBJECT_TABCONSTRAINT") {
		const key = besideTable(from, String(node["subname"]), facts.schema)
		const fact = facts.indexes.get(key)
		if (fact?.table === from && fact.kind !== "index")
			rekey(facts, key, besideTable(from, String(node["newname"]), facts.schema))
	} else if (kind === "OBJECT_COLUMN") renameColumn(facts, from, [String(node["subname"]), String(node["newname"])])
}

/** A CREATE TABLE's indexes: its parent's cloned onto a partition, then its own constraints', then a LIKE's copies */
function followCreate(node: Node, facts: Facts): void {
	const table = tableOf(node["relation"], facts.schema).key
	if (flag(node["if_not_exists"]) && facts.tables.has(table)) return
	if (node["partbound"] !== undefined) {
		const [parent] = (node["inhRelations"] as Node[]).map((each) => tableOf(each["RangeVar"], facts.schema).key)
		for (const fact of indexesOn(facts, parent as string)) clone(facts, fact, { attached: true, table })
	}
	const elements = (node["tableElts"] as Node[] | undefined) ?? []
	const wanted = elements.flatMap((element) => {
		const column = element["ColumnDef"] as Node | undefined
		if (column === undefined)
			return element["Constraint"] === undefined ? [] : [constraintWanted(table, element["Constraint"] as Node)]
		return ((column["constraints"] as Node[] | undefined) ?? []).map((each) =>
			constraintWanted(table, each["Constraint"] as Node, String(column["colname"])),
		)
	})
	for (const each of merged(wanted)) make(facts, each, false)
	for (const element of elements) {
		const like = element["TableLikeClause"] as Node | undefined
		if (like === undefined || (Number(like["options"] ?? 0) & LIKE_INDEXES) === 0) continue
		for (const fact of indexesOn(facts, tableOf(like["relation"], facts.schema).key))
			clone(facts, fact, { attached: false, table })
	}
}

/** CREATE_TABLE_LIKE_INDEXES of Postgres's TableLikeOption, set by INCLUDING INDEXES and INCLUDING ALL */
const LIKE_INDEXES = 64

/**
 * A partition attached to `table`, as AttachPartitionEnsureIndexes attaches it: each of `table`'s
 * indexes takes the first index the partition had that is attached to no other and matches it, a
 * constraint's of the same kind for a constraint; else a clone of it is made there
 */
function attach(facts: Facts, table: string, child: string): void {
	const own = indexesOn(facts, child)
	for (const fact of indexesOn(facts, table)) {
		const match = own.find(
			(each) => each.parent === undefined && same(each, fact) && (fact.kind === "index" || each.kind === fact.kind),
		)
		if (match === undefined) clone(facts, fact, { attached: true, table: child })
		else match.parent = fact
	}
}

/** A constraint added USING INDEX: the index becomes the constraint's, under its name */
function usingIndex(facts: Facts, table: string, constraint: Node): void {
	const key = besideTable(table, String(constraint["indexname"]), facts.schema)
	const fact = facts.indexes.get(key)
	if (fact === undefined) return
	fact.kind = constraint["contype"] === "CONSTR_PRIMARY" ? "primary" : "unique"
	const name = constraint["conname"] as string | undefined
	if (name !== undefined) rekey(facts, key, besideTable(table, name, facts.schema))
}

/** An ALTER TABLE command's drop: a constraint's index, or each index that reads a column, down the partitions */
function followDrop(facts: Facts, table: string, cmd: Node): void {
	const name = String(cmd["name"])
	if (cmd["subtype"] === "AT_DropConstraint") {
		const key = besideTable(table, name, facts.schema)
		const fact = facts.indexes.get(key)
		if (fact?.table === table && fact.kind !== "index") dropIndex(facts, key)
	} else if (cmd["subtype"] === "AT_DropColumn") {
		const tables = lineage(facts, table)
		for (const [key, fact] of Array.from(facts.indexes))
			if (tables.includes(fact.table) && uses(fact.shape).has(name)) dropIndex(facts, key)
	}
}

/** An ALTER TABLE command's index: a constraint's added, or one made the constraint's USING INDEX */
function followAdd(facts: Facts, cmd: Node, { recurse, table }: { recurse: boolean; table: string }): void {
	const def = cmd["def"] as Node | undefined
	if (cmd["subtype"] === "AT_AddColumn") {
		const column = def?.["ColumnDef"] as Node
		const wanted = ((column["constraints"] as Node[] | undefined) ?? []).map((each) =>
			constraintWanted(table, each["Constraint"] as Node, String(column["colname"])),
		)
		for (const each of merged(wanted)) make(facts, each, recurse)
	} else if (cmd["subtype"] === "AT_AddConstraint") {
		const constraint = def?.["Constraint"] as Node
		if (constraint["indexname"] === undefined)
			for (const each of merged([constraintWanted(table, constraint)])) make(facts, each, recurse)
		else usingIndex(facts, table, constraint)
	}
}

/** A partition attached or detached; a detached one's indexes stay, attached to nothing */
function followPartition(facts: Facts, table: string, cmd: Node): void {
	if (cmd["subtype"] !== "AT_AttachPartition" && cmd["subtype"] !== "AT_DetachPartition") return
	const child = tableOf(((cmd["def"] as Node)["PartitionCmd"] as Node)["name"], facts.schema).key
	if (cmd["subtype"] === "AT_AttachPartition") attach(facts, table, child)
	else for (const fact of indexesOn(facts, child)) if (fact.parent?.table === table) fact.parent = undefined
}

/**
 * An ALTER TABLE, in the order its passes run: drops, then each command's constraints, each merged
 * only with its own command's, as ATParseTransformCmd transforms each, on to the partitions but
 * through ONLY, then attaches and detaches; or an ALTER INDEX … ATTACH PARTITION
 */
function followAlter(node: Node, facts: Facts): void {
	const key = tableOf(node["relation"], facts.schema).key
	const cmds = (node["cmds"] as Node[]).map((each) => each["AlterTableCmd"] as Node)
	if (node["objtype"] === "OBJECT_INDEX") {
		const parent = facts.indexes.get(key)
		for (const cmd of cmds) {
			if (cmd["subtype"] !== "AT_AttachPartition") continue
			const child = facts.indexes.get(tableOf(((cmd["def"] as Node)["PartitionCmd"] as Node)["name"], facts.schema).key)
			if (child !== undefined) child.parent = parent
		}
		return
	}
	const recurse = flag((node["relation"] as Node)["inh"])
	for (const cmd of cmds) followDrop(facts, key, cmd)
	for (const cmd of cmds) followAdd(facts, cmd, { recurse, table: key })
	for (const cmd of cmds) followPartition(facts, key, cmd)
}

/** A DROP of tables, each with its indexes and its partitions', or of indexes, each with every one attached to it */
function followDropStmt(node: Node, facts: Facts): void {
	for (const object of node["objects"] as Node[]) {
		const key = keyOf(names((object["List"] as Node)["items"]), facts.schema)
		if (node["removeType"] === "OBJECT_INDEX") dropIndex(facts, key)
		else {
			const tables = lineage(facts, key)
			for (const [index, fact] of Array.from(facts.indexes))
				if (tables.includes(fact.table)) facts.indexes.delete(index)
		}
	}
}

/** `facts.indexes` after one statement: an index made, a table made or altered, an index or table renamed, moved or dropped */
function followIndexes(type: string, node: Node, facts: Facts): void {
	if (type === "IndexStmt") {
		const wanted = indexWanted(tableOf(node["relation"], facts.schema).key, node)
		const named = wanted.name === undefined ? undefined : besideTable(wanted.fact.table, wanted.name, facts.schema)
		if (flag(node["if_not_exists"]) && named !== undefined && taken(facts, named, false)) return
		make(facts, wanted, flag((node["relation"] as Node)["inh"]))
	} else if (type === "CreateStmt") followCreate(node, facts)
	else if (type === "AlterTableStmt") followAlter(node, facts)
	else if (type === "RenameStmt" || type === "AlterObjectSchemaStmt") followName(type, node, facts)
	else if (type === "DropStmt" && (node["removeType"] === "OBJECT_TABLE" || node["removeType"] === "OBJECT_INDEX"))
		followDropStmt(node, facts)
}

export { followIndexes }
