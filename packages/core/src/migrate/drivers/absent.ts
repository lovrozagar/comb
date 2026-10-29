/**
 * A database that does not exist yet, read as the empty database it is: every read answers as an
 * empty SQLite would, and a write refuses. A run reads a missing target through it, so a refused
 * run creates nothing, and opens the real database only once every check has passed (S5 and S6 of
 * the 0.15.0 review).
 */
import type { Connection } from "../types.ts"
import { openMemory } from "./memory.ts"

/** The missing database `name`, read as an empty SQLite; `ownedPrefix` is its engine's, as the real one's */
export async function absentDatabase(name: string, ownedPrefix?: string): Promise<Connection> {
	const db = await openMemory()
	return {
		batch: () => Promise.reject(new Error(`${name} does not exist yet; comb creates it only to apply to it`)),
		close: () => {
			db.close()
			return Promise.resolve()
		},
		dialect: "sqlite",
		execute: (sql, params) => {
			const rows = db.all(sql, params)
			const columns = Object.keys(rows[0] ?? {})
			return Promise.resolve({ columns, rows: rows.map((row) => columns.map((column) => row[column])) })
		},
		ownedPrefix,
	}
}
