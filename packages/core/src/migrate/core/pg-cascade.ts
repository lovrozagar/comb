/**
 * What a CASCADE drop in a Postgres history takes with it, as rating reads the facts after it (P4
 * of r18): Postgres drops each view and materialized view that reads a dropped relation, column or
 * function, each view over those, and each trigger that runs a dropped function; a dropped type
 * takes the columns of it, and a dropped schema everything in it. Rating alone reads this: baseline
 * reads what a cascade leaves from Postgres itself, on its replay of the history (P5 of r19).
 */
import { type Facts, keyOf, names, type Node, nodesOf, type Reads, tableOf } from "./pg-nodes.ts"

/** What `expr` reads: the relations and functions it names, and its column names, `all` for a `*` */
function readsOf(expr: unknown, schema: string): Reads {
	const reads: Reads = { columns: new Set(), functions: new Set(), relations: new Set() }
	for (const [type, node] of nodesOf([expr])) {
		if (type === "RangeVar") reads.relations.add(tableOf(node, schema).key)
		else if (type === "FuncCall") reads.functions.add(keyOf(names(node["funcname"]), schema))
		else if (type === "ColumnRef") {
			const last = (node["fields"] as Node[]).at(-1) as Node
			if (last["A_Star"] !== undefined) reads.columns = "all"
			else if (reads.columns !== "all") reads.columns.add(String((last["String"] as Node)["sval"]))
		}
	}
	return reads
}

/** A view or a materialized view made: what it reads, recorded */
function followReads(type: string, node: Node, facts: Facts): void {
	if (type === "ViewStmt")
		facts.reads.set(tableOf(node["view"], facts.schema).key, readsOf(node["query"], facts.schema))
	else if (type === "CreateTableAsStmt" && node["objtype"] === "OBJECT_MATVIEW")
		facts.reads.set(tableOf((node["into"] as Node)["rel"], facts.schema).key, readsOf(node["query"], facts.schema))
}

/** What a cascade has dropped so far: relations and functions by key, and columns by their table */
type Gone = { columns: Map<string, Set<string>>; functions: Set<string>; relations: Set<string> }

/** Whether `reads` reads anything `gone` holds */
function hits(reads: Reads, gone: Gone): boolean {
	if ([...reads.relations].some((key) => gone.relations.has(key))) return true
	if ([...reads.functions].some((key) => gone.functions.has(key))) return true
	return [...gone.columns].some(
		([table, columns]) =>
			reads.relations.has(table) &&
			(reads.columns === "all" || [...columns].some((c) => (reads.columns as Set<string>).has(c))),
	)
}

/** A relation and everything the facts hold on it, gone */
function dropRelation(key: string, facts: Facts): void {
	for (const map of [facts.views, facts.tables, facts.triggers, facts.reads, facts.columnTypes] as Array<
		Map<string, unknown>
	>)
		map.delete(key)
}

/** Whether `key` is a name in `schema`, an unqualified key being one in the history's own */
const inSchema = (key: string, schema: string, facts: Facts): boolean =>
	schema === facts.schema ? !key.includes(".") : key.startsWith(`${schema}.`)

/** A schema's contents, gone into `gone`: its tables, views and materialized views, and its routines */
function dropSchema(schema: string, gone: Gone, facts: Facts): void {
	for (const key of [...facts.tables.keys(), ...facts.reads.keys()])
		if (inSchema(key, schema, facts)) gone.relations.add(key)
	for (const key of facts.routines.keys()) if (inSchema(key, schema, facts)) gone.functions.add(key)
}

/** The columns of type `type`, gone into `gone`: Postgres drops them with the type */
function dropType(type: string, gone: Gone, facts: Facts): void {
	for (const [table, columns] of facts.columnTypes) {
		const of = [...columns].filter(([, columnType]) => columnType.type === type).map(([column]) => column)
		if (of.length > 0) gone.columns.set(table, new Set([...(gone.columns.get(table) ?? []), ...of]))
	}
}

// lookup-table: the routine kinds a DROP names by their signature
const ROUTINES = /* @__PURE__ */ new Set(["OBJECT_AGGREGATE", "OBJECT_FUNCTION", "OBJECT_PROCEDURE"])

/** What a DROP … CASCADE drops itself: its relations, functions, a type's columns, a schema's contents */
function droppedBy(node: Node, facts: Facts): Gone {
	const gone: Gone = { columns: new Map(), functions: new Set(), relations: new Set() }
	const kind = String(node["removeType"])
	for (const object of node["objects"] as Node[]) {
		if (ROUTINES.has(kind))
			gone.functions.add(keyOf(names((object["ObjectWithArgs"] as Node)["objname"]), facts.schema))
		else if (kind === "OBJECT_SCHEMA") dropSchema(String((object["String"] as Node)["sval"]), gone, facts)
		else if (kind === "OBJECT_TYPE" || kind === "OBJECT_DOMAIN")
			dropType(keyOf(names((object["TypeName"] as Node)["names"]), facts.schema), gone, facts)
		else gone.relations.add(keyOf(names((object["List"] as Node)["items"]), facts.schema))
	}
	return gone
}

/** The views and materialized views that read what `gone` holds, gone too, until no more read one */
function dropReaders(gone: Gone, facts: Facts): void {
	let grew = true
	while (grew) {
		grew = false
		for (const [key, reads] of Array.from(facts.reads)) {
			if (!hits(reads, gone)) continue
			dropRelation(key, facts)
			gone.relations.add(key)
			grew = true
		}
	}
}

/** The facts after `gone` and everything that reads it, transitively, is dropped */
function cascade(gone: Gone, facts: Facts): void {
	for (const [table, columns] of gone.columns) {
		for (const column of columns) facts.tables.get(table)?.delete(column)
		for (const column of columns) facts.columnTypes.get(table)?.delete(column)
	}
	for (const key of gone.relations) dropRelation(key, facts)
	dropReaders(gone, facts)
	for (const [table, triggers] of facts.triggers)
		facts.triggers.set(
			table,
			triggers.filter(({ fn }) => !gone.functions.has(fn)),
		)
}

/** A DROP … CASCADE, or an ALTER TABLE that drops a column CASCADE: its dependents dropped from `facts` */
function followCascade(type: string, node: Node, facts: Facts): void {
	if (type === "DropStmt" && node["behavior"] === "DROP_CASCADE") cascade(droppedBy(node, facts), facts)
	if (type !== "AlterTableStmt") return
	const table = tableOf(node["relation"], facts.schema).key
	const columns = (node["cmds"] as Node[])
		.map((each) => each["AlterTableCmd"] as Node)
		.filter((cmd) => cmd["subtype"] === "AT_DropColumn" && cmd["behavior"] === "DROP_CASCADE")
		.map((cmd) => String(cmd["name"]))
	if (columns.length > 0)
		cascade({ columns: new Map([[table, new Set(columns)]]), functions: new Set(), relations: new Set() }, facts)
}

/** Each of `facts`' reads with each relation key passed through `move` */
function moveReads(facts: Facts, move: (key: string) => string): void {
	for (const reads of facts.reads.values()) reads.relations = new Set([...reads.relations].map(move))
}

export { followCascade, followReads, moveReads, readsOf }
