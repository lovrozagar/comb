/**
 * A `_search` column refolded with searchText (C15 of the 0.14.1 review). searchText folds in JS,
 * which no SQL can express, so a backfill reads each row and writes its fold back: `select` reads
 * every row's rowid, its sources and the text it stores, and `updates` turns those rows into one
 * UPDATE per row whose fold differs from what it stores, so a second run writes nothing and a D1
 * database pays a row write only where one is due. Both are plain SQL, run on any driver, in
 * batches of the caller's size. The table needs its rowid, which every table but a WITHOUT ROWID
 * one has.
 */
import { type SQL, sql } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import { searchText } from "./search.ts"

/** The statements of one refold: the read, and the writes its rows call for */
type Refold = {
	select: SQL
	updates(rows: ReadonlyArray<Record<string, unknown>>): SQL[]
}

/** The refold of `column` from `sources`, in that order, on `table` */
function refoldStatements(table: SQLiteTable, column: SQLiteColumn, sources: readonly SQLiteColumn[]): Refold {
	const read = sources.map((source, i) => sql`${source} AS ${sql.identifier(`s${i}`)}`)
	const select = sql`SELECT rowid AS "rowid", ${column} AS "stored", ${sql.join(read, sql`, `)} FROM ${table}`
	return {
		select,
		updates: (rows) =>
			rows.flatMap((row) => {
				const folded = searchText(...sources.map((_, i) => row[`s${i}`] as string | null))
				if (row["stored"] === folded) return []
				return [sql`UPDATE ${table} SET ${sql.identifier(column.name)} = ${folded} WHERE rowid = ${row["rowid"]}`]
			}),
	}
}

export { type Refold, refoldStatements }
