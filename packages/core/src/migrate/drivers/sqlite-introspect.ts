/**
 * What a SQLite database holds of the schema comb manages, read from sqlite_master: SQLite's own,
 * Litestream's and the engine's tables, the migration history and search indexes left out.
 */
import { HISTORY_TABLES, notEngineTables } from "../core/engine-tables.ts"
import type { Connection } from "../types.ts"

type MasterRow = { name: string; sql: string; type: string }

/* only SQLite's own autoindexes, filtered above, have no sql */
const DEFINED = "sql IS NOT NULL"

// lookup-table: the shadow tables each search module creates beside its virtual table
const SHADOWS: Readonly<Record<string, readonly string[]>> = {
	fts5: ["config", "content", "data", "docsize", "idx"],
	spellfix1: ["vocab"],
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Whether a row belongs to an FTS5 or spellfix1 index: the virtual table, its shadow tables, or a
 * trigger that writes into it. Matched by what the objects are, never by a name's suffix.
 */
function searchIndexObjects(rows: readonly MasterRow[]): (row: MasterRow) => boolean {
	const owned = new Set<string>()
	const virtual: string[] = []
	for (const row of rows) {
		const module = /\bUSING\s+(fts5|spellfix1)\b/i.exec(row.sql)?.[1]?.toLowerCase()
		if (row.type !== "table" || module === undefined) continue
		virtual.push(row.name)
		owned.add(row.name)
		for (const shadow of SHADOWS[module] as readonly string[]) owned.add(`${row.name}_${shadow}`)
	}
	const writesInto = (sql: string) =>
		virtual.some((name) => new RegExp(`\\bINTO\\s+[\x60"\\[]?${escapeRegExp(name)}\\b`, "i").test(sql))
	return (row) => owned.has(row.name) || (row.type === "trigger" && writesInto(row.sql))
}

/** The schema objects comb manages: everything but SQLite's own, Litestream's and search indexes */
async function managedObjects(conn: Connection): Promise<MasterRow[]> {
	const result = await conn.execute(
		`SELECT type, name, sql FROM sqlite_master WHERE ${DEFINED}${notEngineTables(conn, HISTORY_TABLES)}`,
	)
	const rows = result.rows.map(([type, name, sql]) => ({
		name: name as string,
		sql: sql as string,
		type: type as string,
	}))
	const searchIndex = searchIndexObjects(rows)
	return rows.filter((row) => !searchIndex(row))
}

export async function introspectSqliteSchema(conn: Connection): Promise<string> {
	const typeOrder: Record<string, number> = { index: 2, table: 1, trigger: 3 }
	const sorted = (await managedObjects(conn))
		.filter((row) => row.sql && Object.hasOwn(typeOrder, row.type))
		.sort((a, b) => (typeOrder[a.type] as number) - (typeOrder[b.type] as number))
	return `${sorted.map((row) => row.sql).join(";\n\n")};`
}

export async function getSqliteTables(conn: Connection): Promise<string[]> {
	return (await managedObjects(conn)).filter((row) => row.type === "table").map((row) => row.name)
}

export async function getSqliteColumns(conn: Connection, table: string): Promise<string[]> {
	const result = await conn.execute(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
	return result.rows.map((row) => row[1] as string)
}

export async function getSqliteIndexes(conn: Connection): Promise<string[]> {
	return (await managedObjects(conn)).filter((row) => row.type === "index").map((row) => row.name)
}
