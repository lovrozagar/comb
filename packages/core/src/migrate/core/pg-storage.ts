/**
 * Where each table, materialized view and index of a Postgres history keeps its rows,
 * so a move to where it already is reads as the no-op Postgres 17 makes of it: ATPrepChangePersistence
 * returns before the rewrite for a SET LOGGED of a logged table or a SET UNLOGGED of an unlogged one,
 * ATPrepSetAccessMethod for the access method it has, and CheckRelationTableSpaceMove for the
 * tablespace it is in. Its persistence is always the history's. Its access method and tablespace are
 * only where the history names them, at its CREATE or by an ALTER since: one made without USING or
 * TABLESPACE takes the target's default_table_access_method and default_tablespace, which only the
 * target's catalog says (placeStorage, from pg-live-storage.ts). A tablespace renamed carries its relations' name with it; one emptied by an ALTER …
 * ALL IN TABLESPACE leaves where they went unknown, as an OWNED BY may have kept some. A REINDEX
 * with a TABLESPACE option rebuilds indexes there, so it leaves every index's tablespace unknown:
 * a SCHEMA, DATABASE or SYSTEM one reaches indexes the history may not name, and any index it may
 * reach is unknown alike.
 */
import { type Facts, flag, type Node, tableOf } from "./pg-nodes.ts"
import type { Placed, Storage } from "./pg-storage-types.ts"

/** Some of where a relation keeps its rows: what a move sets, or what a check of one knows */
type Where = { [K in keyof Storage]?: Storage[K] | undefined }

/** What a CREATE writes of a relation: its RangeVar, its access method and tablespace, and whether it says IF NOT EXISTS */
type Made = { accessMethod: unknown; again: boolean; rel: Node; tablespace: unknown }

/** A relation made, with its persistence, access method and tablespace as written; an IF NOT EXISTS of one the history holds changes nothing */
function made(facts: Facts, { accessMethod, again, rel, tablespace }: Made): void {
	const key = tableOf(rel, facts.schema).key
	if (again && facts.storage.has(key)) return
	const persistence = rel["relpersistence"]
	const logged = persistence === "p" ? true : persistence === "u" ? false : undefined
	facts.storage.set(key, {
		accessMethod: accessMethod as string | undefined,
		logged,
		tablespace: tablespace as string | undefined,
	})
}

// lookup-table: what each move sets of where a relation keeps its rows, from its command
const MOVES: Readonly<Record<string, (cmd: Node) => Where>> = {
	AT_SetAccessMethod: (cmd) => ({ accessMethod: cmd["name"] as string | undefined }),
	AT_SetLogged: () => ({ logged: true }),
	AT_SetTableSpace: (cmd) => ({ tablespace: cmd["name"] as string | undefined }),
	AT_SetUnLogged: () => ({ logged: false }),
}

/** An ALTER's moves: an index's tablespace on its fact, a table's or materialized view's storage under its key */
function moved(facts: Facts, node: Node): void {
	const key = tableOf(node["relation"], facts.schema).key
	for (const each of node["cmds"] as Node[]) {
		const cmd = each["AlterTableCmd"] as Node
		const move = MOVES[String(cmd["subtype"])]?.(cmd)
		if (move === undefined) continue
		if (node["objtype"] === "OBJECT_INDEX") {
			const index = facts.indexes.get(key)
			if (index !== undefined) index.tablespace = move.tablespace
		} else {
			const was = facts.storage.get(key) ?? { accessMethod: undefined, logged: undefined, tablespace: undefined }
			facts.storage.set(key, { ...was, ...move })
		}
	}
}

/** Each tablespace the history put a relation in, renamed `from` to `to`, or, `to` undefined, no longer known */
function retablespaced(facts: Facts, from: string, to: string | undefined): void {
	for (const where of [...facts.storage.values(), ...facts.indexes.values()])
		if (where.tablespace === from) where.tablespace = to
}

/** Whether a REINDEX names a TABLESPACE to rebuild its indexes in */
const rebuildsElsewhere = (node: Node): boolean =>
	((node["params"] as Array<{ DefElem: Node }> | undefined) ?? []).some(
		({ DefElem }) => DefElem["defname"] === "tablespace",
	)

/** `facts.storage`, and each index's tablespace, after one statement */
function followStorage(type: string, node: Node, facts: Facts): void {
	if (type === "CreateStmt") {
		const rel = node["relation"] as Node
		made(facts, {
			accessMethod: node["accessMethod"],
			again: flag(node["if_not_exists"]),
			rel,
			tablespace: node["tablespacename"],
		})
	} else if (type === "CreateTableAsStmt" || (type === "SelectStmt" && node["intoClause"] !== undefined)) {
		const into = (type === "CreateTableAsStmt" ? node["into"] : node["intoClause"]) as Node
		const again = flag(node["if_not_exists"])
		made(facts, {
			accessMethod: into["accessMethod"],
			again,
			rel: into["rel"] as Node,
			tablespace: into["tableSpaceName"],
		})
	} else if (type === "AlterTableStmt") moved(facts, node)
	else if (type === "RenameStmt" && node["renameType"] === "OBJECT_TABLESPACE")
		retablespaced(facts, String(node["subname"]), String(node["newname"]))
	else if (type === "AlterTableMoveAllStmt") retablespaced(facts, String(node["orig_tablespacename"]), undefined)
	else if (type === "ReindexStmt" && rebuildsElsewhere(node))
		for (const index of facts.indexes.values()) index.tablespace = undefined
}

/** Whether `cmd` moves a relation to where `where` says it already is, which Postgres skips */
function staysPut(cmd: Node, where: Where | undefined): boolean {
	const move = MOVES[String(cmd["subtype"])]?.(cmd)
	if (move === undefined || where === undefined) return false
	return Object.entries(move).every(([field, value]) => value !== undefined && where[field as keyof Storage] === value)
}

/**
 * `facts` as the target holds them where its applied files end: where each relation of `placed` is,
 * from its catalog, in place of what the history's text says or leaves unknown. A pending file's
 * statements then follow it, so a relation one makes again is unknown again
 */
function placeStorage(facts: Facts, placed: Placed): void {
	for (const [key, where] of placed.relations) facts.storage.set(key, { ...where })
	for (const [key, tablespace] of placed.indexes) {
		const index = facts.indexes.get(key)
		if (index !== undefined) index.tablespace = tablespace
	}
}

export { followStorage, placeStorage, staysPut }
