/**
 * What Atlas OSS does not inspect on SQLite, compared by comb before `baseline` records a history
 * (S5 of the 0.14.1 review): triggers, views, virtual tables, and libsql's vector indexes (SL3 of
 * r22), each by what it is and its name, with its definition normalized. The history replays on the
 * engine its files apply on, so a libsql target's vector index replays as it applied.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { openScratch, type ScratchEngine } from "../drivers/local-db.ts"
import type { Connection } from "../types.ts"
import { sqlFiles } from "./atlas-dir.ts"
import { notEngineTables } from "./engine-tables.ts"
import { normalizeSql } from "./sql-scan.ts"

/* the objects Atlas OSS does not inspect on SQLite: triggers, views and virtual tables, FTS5's included (S5), and libsql's vector indexes (SL3 of r22), but the engine's */
const uninspectedOf = (conn: Pick<Connection, "ownedPrefix">): string =>
	`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND (type IN ('trigger', 'view') OR (type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%') OR (type = 'index' AND sql LIKE '%libsql\\_vector\\_idx%' ESCAPE '\\'))${notEngineTables(conn)} ORDER BY rowid`

/** Each object Atlas OSS does not inspect, by what it is and its name, with its definition normalized */
function uninspected(rows: ReadonlyArray<Readonly<Record<string, unknown>>>): Map<string, string> {
	return new Map(
		rows.map((row) => {
			const sql = String(row["sql"])
			const kind =
				row["type"] === "index"
					? "vector index"
					: row["type"] !== "table"
						? String(row["type"])
						: /\bUSING\s+fts5\b/i.test(sql)
							? "FTS table"
							: "virtual table"
			return [`${kind} ${String(row["name"])}`, normalizeSql(sql)]
		}),
	)
}

/** The triggers, views, virtual tables and vector indexes the migrations of `dir` leave, replayed on `engine` a file per connection (S1 of r21) */
async function replayedObjects(dir: string, engine: ScratchEngine): Promise<Map<string, string>> {
	const db = await openScratch(engine)
	try {
		for (const file of sqlFiles(dir)) {
			db.reopen()
			try {
				db.exec(readFileSync(join(dir, file), "utf8"))
			} catch (error) {
				throw new Error(
					`comb could not replay ${file} to compare its triggers and views: ${(error as Error).message}`,
					{
						cause: error,
					},
				)
			}
		}
		return uninspected(db.all(uninspectedOf({})))
	} finally {
		db.close()
	}
}

/**
 * Where the database's triggers, views and virtual tables differ from the ones the migrations
 * leave, by name and normalized definition, as lines of the difference (S5 of the 0.14.1 review)
 */
async function objectDrift(conn: Connection, dir: string, engine: ScratchEngine): Promise<string[]> {
	const live = uninspected(
		(await conn.execute(uninspectedOf(conn))).rows.map(([type, name, sql]) => ({ name, sql, type })),
	)
	const history = await replayedObjects(dir, engine)
	const lines: string[] = []
	for (const [key, sql] of live) {
		const want = history.get(key)
		if (want === undefined) lines.push(`-- ${key}: only in the database`)
		else if (want !== sql) lines.push(`-- ${key}: the database has ${sql}, the migrations ${want}`)
	}
	for (const key of history.keys()) if (!live.has(key)) lines.push(`-- ${key}: only in the migrations`)
	return lines
}

export { objectDrift }
