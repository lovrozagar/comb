/**
 * The tables an engine keeps for itself, which comb never counts as the user's, copies or guards:
 * SQLite's `sqlite_` tables and Litestream's `_litestream_` ones everywhere, and the prefix a
 * connection declares as its engine's (D1's `_cf_`). On every other SQLite engine a `_cf_` table is
 * an ordinary table someone made. One predicate, so no reader of a schema drifts from another (S4
 * of the 0.15.0 review).
 */
import type { Connection } from "../types.ts"
import { D1_HASH_TABLE, D1_MIGRATIONS_TABLE, DRIZZLE_HISTORY_TABLE } from "./d1-history-tables.ts"

/** The history tables comb and wrangler keep, under their default names */
const HISTORY_TABLES: readonly string[] = [DRIZZLE_HISTORY_TABLE, D1_MIGRATIONS_TABLE, D1_HASH_TABLE]

/** `text` as a LIKE pattern that matches it alone, escaped with `\` */
const literal = (text: string): string =>
	text.replaceAll("'", "''").replaceAll("\\", "\\\\").replaceAll("_", "\\_").replaceAll("%", "\\%")

/**
 * The SQL condition, ` AND …`, that leaves out the tables the engine of `conn` owns and, for a
 * reader that counts no history, the `histories` tables
 */
function notEngineTables(conn: Pick<Connection, "ownedPrefix">, histories: readonly string[] = []): string {
	const prefixes = ["sqlite_", "_litestream_", ...(conn.ownedPrefix === undefined ? [] : [conn.ownedPrefix])]
	const owned = prefixes.map((prefix) => ` AND name NOT LIKE '${literal(prefix)}%' ESCAPE '\\'`).join("")
	if (histories.length === 0) return owned
	return `${owned} AND name NOT IN (${histories.map((name) => `'${name.replaceAll("'", "''")}'`).join(", ")})`
}

export { HISTORY_TABLES, notEngineTables }
