/**
 * The database's own foreign keys and triggers, read before a guarded rebuild applies. The guard
 * (rebuild-guard.ts) keeps the rows of the tables the migration history says reach the rebuilt
 * table; a table or trigger made outside the migrations (at runtime, or adopted by a baseline
 * that replayed nothing) is invisible to it, and the rebuild's drop would cascade into it. So comb
 * reads the live graph in one query and refuses when it reaches further than the history does.
 */
import type { Connection } from "../types.ts"
import type { Pending } from "./plan-apply.ts"
import { guardedClosures } from "./rebuild-guard.ts"

const pairs = (rows: unknown[][]): Array<[string, string]> => rows.map((row) => [String(row[0]), String(row[1])])

/* D1 refuses pragma_foreign_key_list as a table but runs PRAGMA foreign_key_list, so a driver that
   reads in batches is asked table by table, this many tables a round trip */
const CHUNK = 100

/** The live foreign keys as child → parent pairs */
async function liveKeys(conn: Connection): Promise<Array<[string, string]>> {
	const executeEach = conn.executeEach?.bind(conn)
	if (executeEach === undefined) {
		const joined = `SELECT m.name, f."table" FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table'`
		return pairs((await conn.execute(joined)).rows)
	}
	/* D1's own _cf_ tables refuse even a pragma, and SQLite's own hold no keys */
	const listed = await conn.execute(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
	)
	const tables = listed.rows.map((row) => String(row[0]))
	const keys: Array<[string, string]> = []
	for (let at = 0; at < tables.length; at += CHUNK) {
		const chunk = tables.slice(at, at + CHUNK)
		const results = await executeEach(chunk.map((table) => `PRAGMA foreign_key_list("${table.replaceAll('"', '""')}")`))
		for (const [i, result] of results.entries()) {
			const parent = result.columns.indexOf("table")
			for (const row of result.rows) keys.push([chunk[i] as string, String(row[parent])])
		}
	}
	return keys
}

/** The live foreign keys as child → parent pairs, and the live triggers by table */
async function liveSchema(
	conn: Connection,
): Promise<{ keys: Array<[string, string]>; triggers: Array<[string, string]> }> {
	const triggers = await conn.execute("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'")
	return { keys: await liveKeys(conn), triggers: pairs(triggers.rows) }
}

/** The tables with a live foreign-key path to `table` */
function liveReach(table: string, keys: ReadonlyArray<[string, string]>): Set<string> {
	const seen = new Set([table])
	const queue = [table]
	for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
		for (const [child, of] of keys) {
			if (of !== parent || seen.has(child)) continue
			seen.add(child)
			queue.push(child)
		}
	}
	seen.delete(table)
	return seen
}

/**
 * Refuses a pending guarded rebuild the live database reaches beyond its history: a table that
 * references the rebuilt one outside the guard's closure, or a trigger the history does not know
 * on a table the guard empties
 */
async function refuseUnseenReach(conn: Connection, pending: readonly Pending[]): Promise<void> {
	const rebuilds = pending.flatMap(({ before, name, sql }) =>
		guardedClosures(sql, before).map((rebuild) => ({ ...rebuild, before, name })),
	)
	if (rebuilds.length === 0) return
	const live = await liveSchema(conn)
	for (const { before, closure, name, table, temp } of rebuilds) {
		const kept = new Set([...closure, table])
		const unseen = [...liveReach(table, live.keys)].find((t) => !kept.has(t) && t !== temp)
		if (unseen !== undefined) {
			throw new Error(
				`${name} rebuilds ${table}, which the database's table ${unseen} references although no migration made it do so; its rows would go with the rebuild, so add ${unseen} to the migrations first`,
			)
		}
		const known = new Set(before.triggers.map((trigger) => trigger.name))
		const trigger = live.triggers.find(([trig, on]) => kept.has(on) && !known.has(trig))
		if (trigger !== undefined) {
			throw new Error(
				`${name} rebuilds ${table}, and the database's trigger ${trigger[0]} on ${trigger[1]}, which no migration made, would fire as comb keeps its rows; drop it first`,
			)
		}
	}
}

export { refuseUnseenReach }
