/**
 * The locks a Postgres file's open transaction holds to its COMMIT that make another session wait
 * (0005 of r22b, the class of PA8): Atlas runs a file in one transaction, so a lock any statement
 * takes lasts through every statement after it, a VALIDATE's scan of every row among them. Each
 * statement's lock is Postgres 17's, measured by tests/integration/postgres/lock-oracle-held.test.ts:
 * ACCESS EXCLUSIVE blocks reads and writes; SHARE, SHARE ROW EXCLUSIVE and EXCLUSIVE block writes;
 * weaker blocks neither. A relation the file made, or a temporary one, no other session sees.
 */
import {
	changeLocks,
	defaultOf,
	EXCLUSIVE,
	EXCLUSIVE_ALL,
	indexLocks,
	keyLocks,
	type Lock,
	on,
	partitionLocks,
	reachLocks,
	reindexLocks,
	SHARE,
	SHARE_ALL,
	truncateLocks,
} from "./pg-lock.ts"
import { type Facts, flag, keyOf, names, type Node, num, type Reads, tableOf, typed, typeOf } from "./pg-nodes.ts"

/* the relations a move to another schema, and a rename, carry with them */
const RELATIONS = /^OBJECT_(?:TABLE|VIEW|MATVIEW|FOREIGN_TABLE)$/

/** The relations the open transaction holds locked, by key, each with whether reads wait too, and the relations it made */
type Held = { locks: Map<string, boolean>; made: Set<string> }

/** A transaction's start: nothing held, nothing made */
const heldStart = (): Held => ({ locks: new Map(), made: new Set() })

/** `held` at a COMMIT, which releases every lock and shows what the file made to other sessions */
function clearHeld(held: Held): void {
	held.locks.clear()
	held.made.clear()
}

/** `held` as Postgres held it, `locks` read from pg_locks, in place of what the file's text says */
function measured(held: Held, locks: ReadonlyMap<string, boolean>): void {
	held.locks.clear()
	for (const [key, reads] of locks) held.locks.set(key, reads)
}

/** `held` with `locks` taken, each but those on what the file made */
function hold(held: Held, locks: readonly Lock[]): void {
	for (const [key, reads] of locks) if (!held.made.has(key)) held.locks.set(key, reads || held.locks.get(key) === true)
}

/** The tables with a column of the type keyed `type` */
const typedTables = (type: string, facts: Facts): string[] =>
	[...facts.columnTypes].filter(([, columns]) => typed(columns, type)).map(([table]) => table)

/** The tables the foreign keys among `constraints` reference */
const referenced = (constraints: unknown): unknown[] =>
	((constraints as Array<{ Constraint: Node }> | undefined) ?? [])
		.map((each) => each.Constraint)
		.filter((constraint) => constraint["contype"] === "CONSTR_FOREIGN")
		.map((constraint) => constraint["pktable"])

/* the ALTER TABLE commands that take SHARE UPDATE EXCLUSIVE or weaker, and the ones that block writes alone */
const UNBLOCKING = /^AT_(?:SetStatistics|SetOptions|ResetOptions|ClusterOn|DropCluster|ValidateConstraint)$/
const TRIGGER_STATE = /^AT_(?:Enable|Disable)\w*Trig/

/** The locks one command of an ALTER TABLE, VIEW, MATERIALIZED VIEW or FOREIGN TABLE takes */
function commandLocks(node: Node, cmd: Node, facts: Facts): Lock[] {
	const table = node["relation"]
	const subtype = cmd["subtype"] as string
	const def = (cmd["def"] ?? {}) as Node
	if (UNBLOCKING.test(subtype)) return []
	if (subtype === "AT_SetRelOptions" || subtype === "AT_ResetRelOptions") {
		const options = ((def["List"] as Node)["items"] as Array<{ DefElem: Node }>).map((each) => each.DefElem["defname"])
		const exclusive = node["objtype"] === "OBJECT_VIEW" || options.includes("user_catalog_table")
		return exclusive ? on(table, facts, EXCLUSIVE) : []
	}
	if (TRIGGER_STATE.test(subtype)) return on(table, facts, SHARE_ALL)
	if (subtype === "AT_AttachPartition" || subtype === "AT_DetachPartition") {
		const partition = on((def["PartitionCmd"] as Node)["name"], facts, EXCLUSIVE)
		const parent = subtype === "AT_DetachPartition" ? on(table, facts, EXCLUSIVE) : []
		return [...parent, ...partition, ...defaultOf(table, facts), ...partitionLocks(table, facts)]
	}
	const constraint = def["Constraint"] as Node | undefined
	if (constraint?.["contype"] === "CONSTR_FOREIGN")
		return [...on(table, facts, SHARE_ALL), ...on(constraint["pktable"], facts, SHARE)]
	const column = def["ColumnDef"] as Node | undefined
	return [
		...on(table, facts, EXCLUSIVE_ALL),
		...referenced(column?.["constraints"]).flatMap((pktable) => on(pktable, facts, SHARE)),
		...changeLocks(table, cmd, facts),
	]
}

/** The locks an ALTER TABLE, INDEX, VIEW, MATERIALIZED VIEW or FOREIGN TABLE's command takes; none for any other ALTER */
function alterLocks(node: Node, cmd: Node, facts: Facts): Lock[] {
	if (node["objtype"] === "OBJECT_INDEX") return indexLocks(node, cmd, facts)
	return RELATIONS.test(node["objtype"] as string) ? commandLocks(node, cmd, facts) : []
}

/** A DROP's objects, each a name's parts */
const dropped = (node: Node): string[][] =>
	(node["objects"] as Array<{ List: Node }>).map((each) => names(each.List["items"]))

/** The locks a DROP of the relation keyed `key` takes: its own, its descendants', a partition's parent's, and through a table's keys */
function relationDrop(key: string, cascade: boolean, facts: Facts): Lock[] {
	const parents = (facts.parents.get(key) ?? []).filter((each) => each.partition)
	return [
		...keyLocks(key, EXCLUSIVE_ALL, facts),
		...parents.map((each): Lock => [each.parent, true]),
		...reachLocks(key, { cascade, kind: "table" }, facts),
	]
}

/** The locks a DROP takes: a relation's, an index's table, a trigger's, policy's or rule's table, and a CASCADE type's tables */
function dropLocks(node: Node, facts: Facts): Lock[] {
	const type = node["removeType"] as string
	if (RELATIONS.test(type))
		return dropped(node).flatMap((parts) =>
			relationDrop(keyOf(parts, facts.schema), node["behavior"] === "DROP_CASCADE", facts),
		)
	if (type === "OBJECT_INDEX")
		return dropped(node).flatMap((parts): Lock[] => {
			const table = facts.indexes.get(keyOf(parts, facts.schema))?.table
			return table === undefined ? [] : [[table, true]]
		})
	if (/^OBJECT_(?:TRIGGER|POLICY|RULE)$/.test(type))
		return dropped(node).map((parts): Lock => [keyOf(parts.slice(0, -1), facts.schema), true])
	if (/^OBJECT_(?:TYPE|DOMAIN)$/.test(type) && node["behavior"] === "DROP_CASCADE")
		return (node["objects"] as Array<{ TypeName: Node }>).flatMap((each) =>
			typedTables(typeOf(each.TypeName, facts.schema), facts).map((table): Lock => [table, true]),
		)
	return []
}

/** The locks a LOCK takes by its mode, on a view's every relation through its query too */
function lockLocks(node: Node, facts: Facts): Lock[] {
	const mode = num(node["mode"])
	if (mode < 5) return []
	return (node["relations"] as Array<{ RangeVar: Node }>).flatMap(({ RangeVar: relation }) => {
		const reached = new Set<string>()
		const reach = (key: string): void => {
			/* a view's reads are recorded with it (pg-cascade.ts), and dropped with it (pg-names.ts) */
			for (const read of facts.views.has(key) ? (facts.reads.get(key) as Reads).relations : []) {
				if (reached.has(read)) continue
				reached.add(read)
				reach(read)
			}
		}
		reach(tableOf(relation, facts.schema).key)
		return [
			...on(relation, facts, { reads: mode === 8, recurse: true }),
			...[...reached].map((key): Lock => [key, mode === 8]),
		]
	})
}

/** The locks a CREATE TABLE takes: a partition's parent and DEFAULT partition, and each table its foreign keys reference */
function createLocks(node: Node, facts: Facts): Lock[] {
	const elements = (node["tableElts"] as Node[] | undefined) ?? []
	const constraints = elements.flatMap((each) =>
		"Constraint" in each
			? [each]
			: (((each["ColumnDef"] as Node | undefined)?.["constraints"] as Node[] | undefined) ?? []),
	)
	/* a partition's one parent */
	const parent =
		node["partbound"] === undefined ? undefined : (node["inhRelations"] as Array<{ RangeVar: Node }>)[0]?.RangeVar
	return [
		...(parent === undefined
			? []
			: [...on(parent, facts, EXCLUSIVE), ...defaultOf(parent, facts), ...partitionLocks(parent, facts)]),
		...referenced(constraints).flatMap((pktable) => on(pktable, facts, SHARE)),
	]
}

/* the renames that take ACCESS EXCLUSIVE on their table; an index's takes SHARE UPDATE EXCLUSIVE */
const EXCLUSIVE_RENAMES = /^OBJECT_(?:TABLE|COLUMN|TABCONSTRAINT|TRIGGER|MATVIEW|VIEW|FOREIGN_TABLE|POLICY|RULE)$/

/** The locks a RENAME takes, through the table's descendants for a column's or constraint's */
const renameLocks = (node: Node, facts: Facts): Lock[] =>
	EXCLUSIVE_RENAMES.test(node["renameType"] as string) && node["relation"] !== undefined
		? on(
				node["relation"],
				facts,
				/^OBJECT_(?:COLUMN|TABCONSTRAINT)$/.test(node["renameType"] as string) ? EXCLUSIVE_ALL : EXCLUSIVE,
			)
		: []

/** The locks an ALTER DOMAIN that scans its columns takes on each table holding one: a validated constraint, NOT NULL, a VALIDATE */
function domainLocks(node: Node, facts: Facts): Lock[] {
	const constraint = (node["def"] as Node | undefined)?.["Constraint"] as Node | undefined
	const subtype = node["subtype"]
	const scans = subtype === "O" || subtype === "V" || (subtype === "C" && !flag(constraint?.["skip_validation"]))
	return scans ? typedTables(keyOf(names(node["typeName"]), facts.schema), facts).map((table) => [table, false]) : []
}

// lookup-table: each statement other than an ALTER TABLE that takes a lock blocking reads or writes, and the locks it takes
const STATEMENTS: Readonly<Record<string, (node: Node, facts: Facts) => Lock[]>> = {
	AlterDomainStmt: domainLocks,
	AlterObjectSchemaStmt: (node, facts) =>
		RELATIONS.test(node["objectType"] as string) ? on(node["relation"], facts, EXCLUSIVE) : [],
	AlterPolicyStmt: (node, facts) => on(node["table"], facts, EXCLUSIVE),
	ClusterStmt: (node, facts) => (node["relation"] === undefined ? [] : on(node["relation"], facts, EXCLUSIVE)),
	CreatePolicyStmt: (node, facts) => on(node["table"], facts, EXCLUSIVE),
	CreateStmt: createLocks,
	CreateTrigStmt: (node, facts) => on(node["relation"], facts, SHARE_ALL),
	DropStmt: dropLocks,
	IndexStmt: (node, facts) => (flag(node["concurrent"]) ? [] : on(node["relation"], facts, SHARE_ALL)),
	LockStmt: lockLocks,
	RefreshMatViewStmt: (node, facts) => on(node["relation"], facts, flag(node["concurrent"]) ? SHARE : EXCLUSIVE),
	ReindexStmt: reindexLocks,
	RenameStmt: renameLocks,
	RuleStmt: (node, facts) => on(node["relation"], facts, EXCLUSIVE),
	TruncateStmt: truncateLocks,
	ViewStmt: (node, facts) =>
		facts.views.has(tableOf(node["view"], facts.schema).key) ? on(node["view"], facts, EXCLUSIVE) : [],
}

/** The key a rename or a move to another schema gives a relation, undefined for any other statement */
function movedTo(type: string, node: Node, facts: Facts): string | undefined {
	const kind = node[type === "RenameStmt" ? "renameType" : "objectType"] as string
	if ((type !== "RenameStmt" && type !== "AlterObjectSchemaStmt") || !RELATIONS.test(kind)) return undefined
	const relation = node["relation"] as { relname: string; schemaname?: string | undefined }
	if (type === "AlterObjectSchemaStmt") return keyOf([String(node["newschema"]), relation.relname], facts.schema)
	return keyOf(
		[...(relation.schemaname === undefined ? [] : [relation.schemaname]), String(node["newname"])],
		facts.schema,
	)
}

/** The relation a statement makes that the history does not hold, undefined for any other statement */
function madeBy(type: string, node: Node, facts: Facts): string | undefined {
	const relation =
		type === "CreateStmt"
			? node["relation"]
			: type === "ViewStmt"
				? node["view"]
				: type === "CreateTableAsStmt" || (type === "SelectStmt" && node["intoClause"] !== undefined)
					? ((type === "SelectStmt" ? node["intoClause"] : node["into"]) as Node)["rel"]
					: undefined
	if (relation === undefined) return undefined
	const { key } = tableOf(relation, facts.schema)
	return facts.tables.has(key) || facts.views.has(key) || facts.reads.has(key) ? undefined : key
}

/**
 * `held`'s record of the relation `from`, its lock or that the file made it, carried to `to`: a
 * relation is named by the one name it has where the file reads it, as the file names it next
 */
function carry(held: Held, from: string, to: string): void {
	const reads = held.locks.get(from)
	if (reads !== undefined) {
		held.locks.delete(from)
		held.locks.set(to, reads || held.locks.get(to) === true)
	}
	if (held.made.delete(from)) held.made.add(to)
}

/** Each key `held` records in the schema a RENAME of it names, carried to the schema's new name */
function carrySchema(node: Node, { facts, held }: { facts: Facts; held: Held }): void {
	for (const key of [...held.locks.keys(), ...held.made]) {
		const parts = key.split(".")
		if ((parts.length > 1 ? parts[0] : facts.schema) === node["subname"])
			carry(held, key, keyOf([String(node["newname"]), parts.at(-1) as string], facts.schema))
	}
}

/** `held` after a top-level statement other than an ALTER TABLE, read before `facts` follow it */
function holdStatement(type: string, node: Node, { facts, held }: { facts: Facts; held: Held }): void {
	const made = madeBy(type, node, facts)
	if (made !== undefined) held.made.add(made)
	hold(held, STATEMENTS[type]?.(node, facts) ?? [])
	/* what the file holds, and what it made, which no other session sees, follow a rename or a move */
	const to = movedTo(type, node, facts)
	if (to !== undefined) carry(held, tableOf(node["relation"], facts.schema).key, to)
	else if (type === "RenameStmt" && node["renameType"] === "OBJECT_SCHEMA") carrySchema(node, { facts, held })
}

export { alterLocks, clearHeld, type Held, heldStart, hold, holdStatement, type Lock, measured }
