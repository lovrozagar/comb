/**
 * The tables an engine keeps for itself, which comb never counts as the user's, copies or guards:
 * SQLite's `sqlite_` tables everywhere, and the prefix a connection declares as its engine's (D1's
 * `_cf_`). On every other SQLite engine a `_cf_` table is an ordinary table someone made.
 */
import type { Connection } from "../types.ts"

/** The SQL condition, ` AND …`, that leaves out the tables the engine of `conn` owns */
function notEngineTables(conn: Pick<Connection, "ownedPrefix">): string {
	const sqlite = " AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
	if (conn.ownedPrefix === undefined) return sqlite
	const prefix = conn.ownedPrefix
		.replaceAll("'", "''")
		.replaceAll("\\", "\\\\")
		.replaceAll("_", "\\_")
		.replaceAll("%", "\\%")
	return `${sqlite} AND name NOT LIKE '${prefix}%' ESCAPE '\\'`
}

export { notEngineTables }
