/**
 * What a Postgres history's statements name, read from their parse trees (pg-history.ts keeps it):
 * each table's triggers, followed through renames, moves to another schema and drops, and every
 * function, procedure and aggregate a migration defined, under each name it ever had.
 */
import type { TriggerEvent } from "../types.ts"
import { type Facts, keyOf, names, type Node, tableOf } from "./pg-nodes.ts"

// lookup-table: the bits of a trigger's events, as pg_trigger numbers them
const EVENTS: ReadonlyArray<[number, TriggerEvent]> = [
	[4, "insert"],
	[8, "delete"],
	[16, "update"],
]

/** A table's facts moved to its new key: a rename, or a move to another schema */
function moveTable(facts: Facts, from: string, to: string): void {
	for (const map of [facts.code, facts.columnTypes, facts.parents, facts.tables, facts.triggers, facts.views] as Array<
		Map<string, unknown>
	>) {
		if (!map.has(from)) continue
		map.set(to, map.get(from))
		map.delete(from)
	}
	for (const parents of facts.parents.values()) for (const each of parents) if (each.parent === from) each.parent = to
	for (const view of facts.views.values()) if (view.base === from) view.base = to
}

/**
 * A key moved from schema `from` to schema `to`, the keys of `schema` (where an unqualified name
 * resolves) unqualified; undefined when it is not under `from`
 */
function movedKey(key: string, { from, to }: { from: string; to: string }, schema: string): string | undefined {
	const parts = key.split(".")
	const under = from === schema ? parts.length === 1 : parts.length > 1 && parts[0] === from
	return under ? keyOf([to, ...(from === schema ? parts : parts.slice(1))], schema) : undefined
}

/**
 * A schema renamed: every table, type, operator and routine named under it moves with it, keys and
 * references alike, and a routine keeps the key it had beside its new one (M74)
 */
function moveSchema(facts: Facts, from: string, to: string): void {
	const move = (key: string) => movedKey(key, { from, to }, facts.schema) ?? key
	const maps = [
		facts.casts,
		facts.code,
		facts.columnTypes,
		facts.domains,
		facts.operators,
		facts.parents,
		facts.tables,
		facts.triggers,
		facts.views,
	]
	for (const map of maps as Array<Map<string, unknown>>) {
		/* a snapshot: the loop moves the entries it reads */
		for (const [key, value] of Array.from(map)) {
			if (move(key) === key) continue
			map.delete(key)
			map.set(move(key), value)
		}
	}
	for (const parents of facts.parents.values()) for (const each of parents) each.parent = move(each.parent)
	for (const view of facts.views.values()) if (view.base !== undefined) view.base = move(view.base)
	for (const cast of facts.casts.values()) cast.fn = move(cast.fn)
	for (const map of [facts.domains, facts.operators]) for (const [key, fn] of map) map.set(key, move(fn))
	for (const key of Array.from(facts.defined)) facts.defined.add(move(key))
}

/** A trigger made, renamed or dropped */
function followTrigger(type: string, node: Node, facts: Facts): void {
	if (type === "CreateTrigStmt") {
		const table = tableOf(node["relation"], facts.schema).key
		const name = String(node["trigname"])
		const events = EVENTS.filter(([bit]) => ((node["events"] as number) & bit) !== 0).map(([, event]) => event)
		const kept = (facts.triggers.get(table) ?? []).filter((each) => each.name !== name)
		facts.triggers.set(table, [...kept, { enabled: true, events, name }])
	} else if (type === "RenameStmt" && node["renameType"] === "OBJECT_TRIGGER") {
		const table = tableOf(node["relation"], facts.schema).key
		for (const each of facts.triggers.get(table) ?? [])
			if (each.name === node["subname"]) each.name = String(node["newname"])
	} else if (type === "DropStmt" && node["removeType"] === "OBJECT_TRIGGER") {
		for (const object of node["objects"] as Node[]) {
			const parts = names((object["List"] as Node)["items"])
			const table = keyOf(parts.slice(0, -1), facts.schema)
			facts.triggers.set(
				table,
				(facts.triggers.get(table) ?? []).filter((each) => each.name !== parts.at(-1)),
			)
		}
	}
}

// lookup-table: the relations a rename, a move or a drop follows: a table, and what Postgres writes through as one (M71)
const RELATIONS = /* @__PURE__ */ new Set(["OBJECT_FOREIGN_TABLE", "OBJECT_MATVIEW", "OBJECT_TABLE", "OBJECT_VIEW"])

/** A column renamed: a table's column, or a view's, whose base column stays the one it named */
function renameColumn(node: Node, facts: Facts): void {
	const key = tableOf(node["relation"], facts.schema).key
	const [was, now] = [String(node["subname"]), String(node["newname"])]
	const columns = facts.tables.get(key)
	if (columns?.delete(was) === true) columns.add(now)
	const view = facts.views.get(key)
	const base = view?.columns === "all" ? undefined : view?.columns.get(was)
	if (base === undefined || view === undefined || view.columns === "all") return
	view.columns.delete(was)
	view.columns.set(now, base)
}

// lookup-table: the kinds of object a routine's rename or move names
const ROUTINES = /* @__PURE__ */ new Set(["OBJECT_AGGREGATE", "OBJECT_FUNCTION", "OBJECT_PROCEDURE", "OBJECT_ROUTINE"])

/** A routine's name parts from an ObjectWithArgs */
const routineOf = (object: unknown): string[] => names(((object as Node)["ObjectWithArgs"] as Node)["objname"])

/** A schema renamed, or a table or routine renamed or moved to another schema: the table's facts follow it; the routine gains the name */
function followName(type: string, node: Node, facts: Facts): void {
	const kind = String(node[type === "RenameStmt" ? "renameType" : "objectType"])
	if (kind === "OBJECT_SCHEMA" && type === "RenameStmt")
		moveSchema(facts, String(node["subname"]), String(node["newname"]))
	else if (kind === "OBJECT_COLUMN" && type === "RenameStmt") renameColumn(node, facts)
	else if (RELATIONS.has(kind)) {
		const rel = node["relation"] as { relname: string; schemaname?: string }
		const to =
			type === "RenameStmt"
				? keyOf(
						rel.schemaname === undefined ? [String(node["newname"])] : [rel.schemaname, String(node["newname"])],
						facts.schema,
					)
				: keyOf([String(node["newschema"]), rel.relname], facts.schema)
		moveTable(facts, tableOf(rel, facts.schema).key, to)
	} else if (ROUTINES.has(kind)) {
		const parts = routineOf(node["object"])
		facts.defined.add(
			keyOf(
				type === "RenameStmt"
					? [...parts.slice(0, -1), String(node["newname"])]
					: [String(node["newschema"]), parts.at(-1) as string],
				facts.schema,
			),
		)
	}
}

/** A table or view dropped takes its triggers, its columns and its view with it */
function followDrop(node: Node, facts: Facts): void {
	if (!RELATIONS.has(String(node["removeType"]))) return
	for (const object of node["objects"] as Node[]) {
		const table = keyOf(names((object["List"] as Node)["items"]), facts.schema)
		facts.triggers.delete(table)
		facts.tables.delete(table)
		facts.views.delete(table)
	}
}

/**
 * `facts` after a statement that names or renames what the history holds: a trigger made, renamed
 * or dropped, a table or routine renamed or moved, a table dropped; whether `type` was one
 */
function followNames(type: string, node: Node, facts: Facts): boolean {
	if (type === "CreateTrigStmt" || (type === "RenameStmt" && node["renameType"] === "OBJECT_TRIGGER"))
		followTrigger(type, node, facts)
	else if (type === "RenameStmt" || type === "AlterObjectSchemaStmt") followName(type, node, facts)
	else if (type === "DropStmt") {
		followTrigger(type, node, facts)
		followDrop(node, facts)
	} else return false
	return true
}

export { followNames, movedKey }
