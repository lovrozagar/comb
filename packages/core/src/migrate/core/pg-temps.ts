/**
 * A file's temp relations, named as Postgres's search path names them. pg_temp leads
 * the search path, so once a file makes a temp table, view or sequence, an unqualified name of it
 * in a later statement of the file is the temp relation, not a table of that name; a CREATE without
 * TEMP still makes its relation in the current schema. comb's apply runs one Atlas call per file, a
 * session of its own, so a temp relation dies when its file ends. resolveTemps writes each such
 * name `pg_temp.<name>` in a copy of the statement's tree, so every rule that keys a relation keys
 * it apart from the table it shadows; historyFacts then forgets every pg_temp key at each file's end
 * (forgetTemps). An index Postgres names itself on a temp table is not followed: an unqualified DROP
 * INDEX of one keys the current schema's index of that name.
 */
import type { Facts, Node } from "./pg-nodes.ts"

/** The temp relations a file made so far: each by its bare name, with the table it belongs to, itself for a table, view or sequence */
type Temps = Map<string, string>

/** A RangeVar's fields */
type RangeVar = { relname: string; relpersistence: string; schemaname?: string | undefined }

const isRangeVar = (value: object): value is RangeVar =>
	typeof (value as RangeVar).relname === "string" && typeof (value as RangeVar).relpersistence === "string"

/* a CREATE's target is a plain field, not a typed node, each kind's own */
// lookup-table: a statement that makes a relation, to the RangeVar it makes
const MADE: Readonly<Record<string, (node: Node) => unknown>> = {
	CompositeTypeStmt: (node) => node["typevar"],
	CreateForeignTableStmt: (node) => (node["base"] as Node)["relation"],
	CreateSeqStmt: (node) => node["sequence"],
	CreateStmt: (node) => node["relation"],
	CreateTableAsStmt: (node) => (node["into"] as Node)["rel"],
	SelectStmt: (node) => (node["intoClause"] as Node | undefined)?.["rel"],
	ViewStmt: (node) => node["view"],
}

/** The relation a top-level statement makes, undefined for any other statement */
const madeBy = (type: string, node: Node): RangeVar | undefined => MADE[type]?.(node) as RangeVar | undefined

/** Whether a made relation is temporary: TEMP, or made in pg_temp */
const temporary = (made: RangeVar): boolean => made.relpersistence === "t" || made.schemaname === "pg_temp"

// lookup-table: the kinds a DROP or a RENAME names a relation of by its name, an index among them
const RELATIONS = /* @__PURE__ */ new Set([
	"OBJECT_FOREIGN_TABLE",
	"OBJECT_INDEX",
	"OBJECT_MATVIEW",
	"OBJECT_SEQUENCE",
	"OBJECT_TABLE",
	"OBJECT_VIEW",
])

// lookup-table: the kinds a DROP names by their table's name, then their own
const ON_TABLE = /* @__PURE__ */ new Set(["OBJECT_POLICY", "OBJECT_RULE", "OBJECT_TRIGGER"])

const PG_TEMP = { String: { sval: "pg_temp" } }

/**
 * Every RangeVar under `value` but `made` that names a temp relation of the file, written pg_temp;
 * whether any of them reaches a temp relation
 */
function qualify(value: unknown, made: RangeVar | undefined, temps: Temps): boolean {
	let reaches = false
	if (Array.isArray(value)) for (const each of value) reaches = qualify(each, made, temps) || reaches
	else if (value !== null && typeof value === "object") {
		if (value !== made && isRangeVar(value)) {
			if (value.schemaname === undefined && temps.has(value.relname)) value.schemaname = "pg_temp"
			reaches = value.schemaname === "pg_temp"
		}
		for (const each of Object.values(value)) reaches = qualify(each, made, temps) || reaches
	}
	return reaches
}

/** A DROP's name lists, each a temp relation's or its table's written pg_temp; the temp relations it drops */
function qualifyDrop(node: Node, temps: Temps): string[] {
	const kind = String(node["removeType"])
	const dropped: string[] = []
	for (const object of node["objects"] as Node[]) {
		const items = (object["List"] as Node | undefined)?.["items"] as Array<{ String: { sval: string } }> | undefined
		/* a DROP SCHEMA, a type's or a routine's names no relation by a list */
		if (items === undefined) continue
		const parts = items.map((item) => item.String.sval)
		const first = parts[0] as string
		if (RELATIONS.has(kind) && parts.length === 1 && temps.has(first)) {
			items.unshift(structuredClone(PG_TEMP))
			dropped.push(first)
		} else if (RELATIONS.has(kind) && parts.length === 2 && first === "pg_temp") dropped.push(parts[1] as string)
		else if (ON_TABLE.has(kind) && parts.length === 2 && temps.has(first)) items.unshift(structuredClone(PG_TEMP))
	}
	return dropped
}

/** `temps` after a DROP of `dropped`: each, a table with every index of it */
function forgetDropped(dropped: readonly string[], temps: Temps): void {
	for (const name of dropped) {
		const table = temps.get(name) === name
		for (const [each, of] of Array.from(temps)) if (each === name || (table && of === name)) temps.delete(each)
	}
}

/** `temps` after a temp relation's RENAME: its name, and its indexes' table's */
function renamed(node: Node, temps: Temps): void {
	const [was, now] = [(node["relation"] as RangeVar).relname, String(node["newname"])]
	const table = temps.get(was) as string
	temps.delete(was)
	temps.set(now, table === was ? now : table)
	if (table === was) for (const [each, of] of Array.from(temps)) if (of === was) temps.set(each, now)
}

/** One top-level statement of the file, its names of the file's temp relations written pg_temp, followed into `temps` */
function resolveStatement(type: string, node: Node, temps: Temps): void {
	const made = madeBy(type, node)
	const reaches = qualify(node, made, temps)
	/* a view that reads a temp relation is temporary itself, as Postgres makes it */
	if (made !== undefined && (temporary(made) || (type === "ViewStmt" && reaches))) {
		made.schemaname = "pg_temp"
		made.relpersistence = "t"
		temps.set(made.relname, made.relname)
	} else if (type === "DropStmt") forgetDropped(qualifyDrop(node, temps), temps)
	else if (
		type === "RenameStmt" &&
		RELATIONS.has(String(node["renameType"])) &&
		(node["relation"] as RangeVar | undefined)?.schemaname === "pg_temp" &&
		temps.has((node["relation"] as RangeVar).relname)
	)
		renamed(node, temps)
	else if (
		type === "IndexStmt" &&
		(node["relation"] as RangeVar).schemaname === "pg_temp" &&
		node["idxname"] !== undefined
	)
		temps.set(String(node["idxname"]), (node["relation"] as RangeVar).relname)
}

/** A statement's parse tree: its RawStmts */
type Raws = Array<{ stmt: Record<string, Node> }>

/** Each top-level statement of `raws`, by its type */
const tops = (raws: Raws): Array<[string, Node]> => raws.flatMap((raw) => Object.entries(raw.stmt))

/**
 * A statement's parse tree with each name of a temp relation its file made before it written
 * `pg_temp.<name>`, and the temp relation it makes written so, followed into `temps`: a copy when it
 * changes anything, `stmts` itself when the file has made no temp relation and this makes none
 */
function resolveTemps(stmts: unknown, temps: Temps): unknown {
	const raws = stmts as Raws
	const makes = tops(raws).some(([type, node]) => {
		const made = madeBy(type, node)
		return made !== undefined && temporary(made)
	})
	if (temps.size === 0 && !makes) return stmts
	const copy = structuredClone(raws)
	for (const [type, node] of tops(copy)) resolveStatement(type, node, temps)
	return copy
}

/** Whether `key` is a temp relation's, or a name beside one */
const inTemp = (key: string): boolean => key.startsWith("pg_temp.")

/**
 * `facts` after a file ends, as its session does: every temp relation it made gone, with every
 * fact keyed by one and every foreign key of one
 */
function forgetTemps(facts: Facts): void {
	for (const value of Object.values(facts))
		if (value instanceof Map || value instanceof Set)
			for (const key of Array.from(value.keys())) if (inTemp(String(key))) value.delete(key)
	facts.foreignKeys = facts.foreignKeys.filter((key) => !inTemp(key.table) && !inTemp(key.references))
}

export { forgetTemps, resolveTemps, type Temps }
