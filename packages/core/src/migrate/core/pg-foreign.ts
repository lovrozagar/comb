/**
 * The foreign keys and primary keys a Postgres history leaves, read from its parse trees, and the
 * tables a statement reaches through them: Postgres locks the table at
 * a key's other end when the key is dropped, rebuilt or checked, so a dropped key, a dropped table's
 * keys, a key column retyped, a TRUNCATE CASCADE and a partition under a parent's keys each lock a
 * table the statement does not name. A key Postgres names is named as ChooseConstraintName names it;
 * a name taken by a CHECK or UNIQUE constraint, which this does not record, is not seen. A primary key
 * ADD … USING INDEX makes has its index's columns, which this does not record, so a key naming them is
 * not reached through it.
 */
import { movedKey } from "./pg-names.ts"
import { type Facts, flag, keyOf, names, type Node, tableOf } from "./pg-nodes.ts"

/** A foreign key: its name, its table and columns, and the table it references with the columns there, [] for its primary key */
type ForeignKey = { columns: string[]; name: string; references: string; table: string; to: string[] }

/** A table's primary key: its name and columns */
type PrimaryKey = { columns: string[]; name: string }

/** The schema part of a key, "" for the schema an unqualified name resolves in */
const schemaOf = (key: string): string => (key.includes(".") ? (key.split(".")[0] as string) : "")

/** The bare name of a key */
const bare = (key: string): string => key.split(".").at(-1) as string

/** `text` clipped to `bytes` UTF-8 bytes, never mid-character */
function clipped(text: string, bytes: number): string {
	let out = ""
	for (const char of text) {
		if (Buffer.byteLength(out + char) > bytes) break
		out += char
	}
	return out
}

/** A name as Postgres's makeObjectName builds it: `name1`_`name2`_`label`, the longer of the two cut first to 63 bytes */
function objectName(name1: string, name2: string, label: string): string {
	const avail = 63 - (Buffer.byteLength(label) + 1) - (name2 === "" ? 0 : 1)
	let [one, two] = [Buffer.byteLength(name1), Buffer.byteLength(name2)]
	while (one + two > avail)
		if (one > two) one -= 1
		else two -= 1
	return [clipped(name1, one), ...(name2 === "" ? [] : [clipped(name2, two)]), label].join("_")
}

/** A foreign key's name as Postgres chooses it on `table`: `fkey`, then `fkey1`, 2, … past a name its schema's keys take */
function chosen(table: string, columns: readonly string[], facts: Facts): string {
	const taken = new Set(
		[
			...facts.foreignKeys.map((key) => [key.table, key.name]),
			...[...facts.primaryKeys].map(([on, key]) => [on, key.name]),
		]
			.filter(([on]) => schemaOf(on as string) === schemaOf(table))
			.map(([, name]) => name),
	)
	for (let pass = 0; ; pass += 1) {
		const name = objectName(bare(table), columns.join("_"), pass === 0 ? "fkey" : `fkey${pass}`)
		if (!taken.has(name)) return name
	}
}

/** `facts` with a constraint of `table` added: a foreign key or a primary key, on `column` when a column declares it */
function addConstraint(
	{ column, table }: { column?: string | undefined; table: string },
	constraint: Node,
	facts: Facts,
): void {
	const conname = constraint["conname"] as string | undefined
	if (constraint["contype"] === "CONSTR_FOREIGN") {
		const columns = column === undefined ? names(constraint["fk_attrs"]) : [column]
		facts.foreignKeys.push({
			columns,
			name: conname ?? chosen(table, columns, facts),
			references: tableOf(constraint["pktable"], facts.schema).key,
			table,
			to: names(constraint["pk_attrs"] ?? []),
		})
	} else if (constraint["contype"] === "CONSTR_PRIMARY") {
		const index = constraint["indexname"] as string | undefined
		const columns = column === undefined ? names(constraint["keys"] ?? []) : [column]
		facts.primaryKeys.set(table, { columns, name: conname ?? index ?? objectName(bare(table), "", "pkey") })
	}
}

/** The columns a foreign key references: its own list, or its table's primary key */
const targetOf = (key: ForeignKey, facts: Facts): string[] =>
	key.to.length > 0 ? key.to : (facts.primaryKeys.get(key.references)?.columns ?? [])

/** Whether two column lists name the same columns, in any order, as a key's unique index matches its referenced columns */
const sameColumns = (one: readonly string[], two: readonly string[]): boolean =>
	one.length === two.length && one.every((column) => two.includes(column))

/** What a change to `table` reaches through its keys: the tables its own keys reference, and the tables whose keys reference it */
type Reach = { referenced: string[]; referencing: string[] }

/** The keys a change to `table` drops or rebuilds: those of its own it touches, and those to it */
type Change =
	| { cascade: boolean; kind: "column" | "constraint"; name: string }
	| { kind: "retype"; name: string }
	| { cascade: boolean; kind: "table" }

/** Whether a key of `table` itself goes with `change` */
function ownGoes(key: ForeignKey, change: Change): boolean {
	if (change.kind === "table") return true
	return change.kind === "constraint" ? key.name === change.name : key.columns.includes(change.name)
}

/** Whether a key to `table` goes with `change` */
function toGoes(key: ForeignKey, change: Change, facts: Facts): boolean {
	if (change.kind === "retype") return targetOf(key, facts).includes(change.name)
	if (!change.cascade) return false
	if (change.kind === "table") return true
	if (change.kind === "column") return targetOf(key, facts).includes(change.name)
	const primary = facts.primaryKeys.get(key.references)
	return primary?.name === change.name && sameColumns(targetOf(key, facts), primary.columns)
}

/** The tables `change` to `table` locks through the keys it drops or rebuilds, `table` itself left out */
function keyReach(table: string, change: Change, facts: Facts): Reach {
	const own = facts.foreignKeys.filter((key) => key.table === table && ownGoes(key, change))
	const to = facts.foreignKeys.filter((key) => key.references === table && toGoes(key, change, facts))
	return {
		referenced: own.map((key) => key.references).filter((key) => key !== table),
		referencing: to.map((key) => key.table).filter((key) => key !== table),
	}
}

/** Every table a TRUNCATE CASCADE of `tables` truncates through the keys to them, each with `within` it, `tables` left out */
function truncated(tables: readonly string[], facts: Facts, within: (key: string) => string[]): string[] {
	const reached = new Set(tables)
	for (let grew = true; grew;) {
		grew = false
		for (const key of facts.foreignKeys)
			if (reached.has(key.references) && !reached.has(key.table)) {
				for (const each of within(key.table)) reached.add(each)
				grew = true
			}
	}
	return [...reached].filter((key) => !tables.includes(key))
}

/** The tables the keys of partitioned `table` and its ancestors reference, which a partition made, attached or detached under it checks */
function partitionReach(table: string, facts: Facts): string[] {
	const up = (key: string): string[] => [
		key,
		...(facts.parents.get(key) ?? []).filter((each) => each.partition).flatMap((each) => up(each.parent)),
	]
	const lineage = up(table)
	return facts.foreignKeys.filter((key) => lineage.includes(key.table)).map((key) => key.references)
}

/** `facts` with the keys `change` drops from `table` gone */
function dropKeys(table: string, change: Change, facts: Facts): void {
	facts.foreignKeys = facts.foreignKeys.filter(
		(key) =>
			!(key.table === table && ownGoes(key, change)) && !(key.references === table && toGoes(key, change, facts)),
	)
	const primary = facts.primaryKeys.get(table)
	const name = change.kind === "table" ? undefined : change.name
	if (
		change.kind === "table" ||
		primary?.name === name ||
		(change.kind === "column" && primary?.columns.includes(name as string))
	)
		facts.primaryKeys.delete(table)
}

/** `facts` with each key's tables under the keys `move` gives them */
function moveKeys(facts: Facts, move: (key: string) => string): void {
	for (const key of facts.foreignKeys) {
		key.table = move(key.table)
		key.references = move(key.references)
	}
	for (const [table, key] of Array.from(facts.primaryKeys)) {
		facts.primaryKeys.delete(table)
		facts.primaryKeys.set(move(table), key)
	}
}

/** `facts` after a column of `table` renamed: its keys' columns, and the columns keys to it name */
function renameKeyColumn(table: string, [was, now]: [string, string], facts: Facts): void {
	const renamed = (columns: string[]) => columns.map((column) => (column === was ? now : column))
	for (const key of facts.foreignKeys) {
		if (key.table === table) key.columns = renamed(key.columns)
		if (key.references === table) key.to = renamed(key.to)
	}
	const primary = facts.primaryKeys.get(table)
	if (primary !== undefined) primary.columns = renamed(primary.columns)
}

/** A RENAME of a table, a schema, a column or a constraint, or a table's SET SCHEMA, followed */
function followKeyName(type: string, node: Node, facts: Facts): void {
	const kind = node[type === "RenameStmt" ? "renameType" : "objectType"]
	if (kind === "OBJECT_SCHEMA" && type === "RenameStmt") {
		const schemas = { from: String(node["subname"]), to: String(node["newname"]) }
		return moveKeys(facts, (key) => movedKey(key, schemas, facts.schema) ?? key)
	}
	const rel = node["relation"] as { relname: string; schemaname?: string | undefined } | undefined
	if (rel === undefined) return
	const table = tableOf(rel, facts.schema).key
	const [was, now] = [String(node["subname"]), String(node["newname"])]
	if (kind === "OBJECT_COLUMN") renameKeyColumn(table, [was, now], facts)
	else if (kind === "OBJECT_TABCONSTRAINT") {
		for (const key of facts.foreignKeys) if (key.table === table && key.name === was) key.name = now
		const primary = facts.primaryKeys.get(table)
		if (primary?.name === was) primary.name = now
	} else if (kind === "OBJECT_TABLE") {
		const to =
			type === "RenameStmt"
				? keyOf(rel.schemaname === undefined ? [now] : [rel.schemaname, now], facts.schema)
				: keyOf([String(node["newschema"]), rel.relname], facts.schema)
		moveKeys(facts, (key) => (key === table ? to : key))
	}
}

/** CREATE_TABLE_LIKE_INDEXES of Postgres's TableLikeOption, set by INCLUDING INDEXES and INCLUDING ALL */
const LIKE_INDEXES = 64

/** The primary key a LIKE copies with the indexes, named as a new one is; a LIKE copies no foreign key */
function copyPrimaryKey(table: string, like: Node, facts: Facts): void {
	const primary = facts.primaryKeys.get(tableOf(like["relation"], facts.schema).key)
	if (primary !== undefined && (Number(like["options"] ?? 0) & LIKE_INDEXES) !== 0)
		facts.primaryKeys.set(table, { columns: [...primary.columns], name: objectName(bare(table), "", "pkey") })
}

/** A CREATE TABLE's keys, declared on its columns and on itself; one the history holds stays as it was through IF NOT EXISTS */
function followKeyCreate(node: Node, facts: Facts): void {
	const table = tableOf(node["relation"], facts.schema).key
	if (flag(node["if_not_exists"]) && facts.tables.has(table)) return
	dropKeys(table, { cascade: false, kind: "table" }, facts)
	for (const element of (node["tableElts"] as Node[] | undefined) ?? []) {
		const column = element["ColumnDef"] as Node | undefined
		const like = element["TableLikeClause"] as Node | undefined
		if (like !== undefined) copyPrimaryKey(table, like, facts)
		else if (column === undefined) addConstraint({ table }, element["Constraint"] as Node, facts)
		else
			for (const each of (column["constraints"] as Array<{ Constraint: Node }> | undefined) ?? [])
				addConstraint({ column: String(column["colname"]), table }, each.Constraint, facts)
	}
}

/** An ALTER TABLE's keys: each added, each dropped with its constraint or column */
function followKeyAlter(node: Node, facts: Facts): void {
	const table = tableOf(node["relation"], facts.schema).key
	for (const each of node["cmds"] as Array<{ AlterTableCmd: Node }>) {
		const cmd = each.AlterTableCmd
		const def = (cmd["def"] ?? {}) as Node
		const cascade = cmd["behavior"] === "DROP_CASCADE"
		const name = String(cmd["name"])
		if (cmd["subtype"] === "AT_AddConstraint") addConstraint({ table }, def["Constraint"] as Node, facts)
		else if (cmd["subtype"] === "AT_AddColumn") {
			const column = def["ColumnDef"] as Node
			for (const one of (column["constraints"] as Array<{ Constraint: Node }> | undefined) ?? [])
				addConstraint({ column: String(column["colname"]), table }, one.Constraint, facts)
		} else if (cmd["subtype"] === "AT_DropConstraint") dropKeys(table, { cascade, kind: "constraint", name }, facts)
		else if (cmd["subtype"] === "AT_DropColumn") dropKeys(table, { cascade, kind: "column", name }, facts)
	}
}

/** `facts` after a statement that makes, renames, moves or drops a key or its table */
function followForeign(type: string, node: Node, facts: Facts): void {
	if (type === "CreateStmt") followKeyCreate(node, facts)
	else if (type === "AlterTableStmt" && node["objtype"] === "OBJECT_TABLE") followKeyAlter(node, facts)
	else if (type === "RenameStmt" || type === "AlterObjectSchemaStmt") followKeyName(type, node, facts)
	else if (type === "DropStmt" && node["removeType"] === "OBJECT_TABLE")
		for (const object of node["objects"] as Array<{ List: Node }>)
			dropKeys(
				keyOf(names(object.List["items"]), facts.schema),
				{ cascade: node["behavior"] === "DROP_CASCADE", kind: "table" },
				facts,
			)
}

export {
	type Change,
	clipped,
	followForeign,
	type ForeignKey,
	keyReach,
	objectName,
	partitionReach,
	type PrimaryKey,
	truncated,
}
