/**
 * The database's own foreign keys and triggers, read before a guarded rebuild applies. The guard
 * (rebuild-guard.ts) keeps the rows of the tables the migration history says reach the rebuilt
 * table; a table or trigger made outside the migrations (at runtime, or adopted by a baseline
 * that replayed nothing) is invisible to it, and the rebuild's drop would cascade into it. So comb
 * reads the live graph in one query and refuses when it reaches further than the history does.
 */
import type { Connection } from "../types.ts"
import type { Pending } from "./plan-apply.ts"
import type { ExtractedSchema } from "../types.ts"
import { notEngineTables } from "./engine-tables.ts"
import { locateRebuilds, reached, schemaAt } from "./rebuild-guard.ts"
import { asciiFold, codeOf } from "./sql-code.ts"
import { splitSqlStatements } from "./sql-scan.ts"

/* SQLite matches a table or trigger name without regard to case, and the catalog keeps each as written */
const folded = (name: unknown): string => asciiFold(String(name))
const pairs = (rows: unknown[][]): Array<[string, string]> => rows.map((row) => [folded(row[0]), folded(row[1])])

/**
 * The live foreign keys as child → parent pairs, in one query (one wrangler call on D1). D1 refuses
 * pragma_foreign_key_list on its own _cf_ tables, so they are left out before the join reaches them.
 */
async function liveKeys(conn: Connection): Promise<Array<[string, string]>> {
	const joined = `SELECT m.name, f."table" FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table'${notEngineTables(conn)}`
	return pairs((await conn.execute(joined)).rows)
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

/** Each table a file rebuilds, with the tables its drop reaches by the history (none for an unreferenced one) */
function rebuildClosures(
	sql: string,
	before: ExtractedSchema,
): Array<{ closure: string[]; table: string; temp: string }> {
	const statements = splitSqlStatements(sql)
	return locateRebuilds(
		statements,
		statements.map((stmt) => codeOf(stmt, "sqlite")),
	).map((rebuild) => ({
		closure: reached(rebuild.table, schemaAt(statements, rebuild, before)),
		table: rebuild.table,
		temp: rebuild.temp,
	}))
}

/**
 * Refuses a pending rebuild the live database reaches beyond its history: a table that references
 * the rebuilt one outside the guard's closure (empty when the history shows none, and no guard is
 * written), or a trigger the history does not know on a table the guard empties
 */
async function refuseUnseenReach(conn: Connection, pending: readonly Pending[]): Promise<void> {
	const rebuilds = pending.flatMap(({ before, name, sql }) =>
		rebuildClosures(sql, before).map((rebuild) => ({ ...rebuild, before, name })),
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
		/* an unguarded rebuild empties no table: its drop takes its own triggers, and fires none */
		const trigger =
			closure.length === 0 ? undefined : live.triggers.find(([trig, on]) => kept.has(on) && !known.has(trig))
		if (trigger !== undefined) {
			throw new Error(
				`${name} rebuilds ${table}, and the database's trigger ${trigger[0]} on ${trigger[1]}, which no migration made, would fire as comb keeps its rows; drop it first`,
			)
		}
	}
}

export { refuseUnseenReach }
