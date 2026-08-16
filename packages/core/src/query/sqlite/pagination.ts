/**
 * SQLite keyset cursor pagination — parameterized (no sql.raw injection).
 */
import { type SQL, sql } from "drizzle-orm"
import type { SQLiteColumn } from "drizzle-orm/sqlite-core"

import type { CursorInfo } from "../cursor.ts"
import type { SortField } from "../types.ts"

type CursorSQLConfig = {
	columns: { id: SQLiteColumn }
	sortColumns: Record<string, SQLiteColumn | undefined>
	tableAlias: string
}

/**
 * Build parameterized cursor WHERE clause for keyset pagination.
 * Uses sql`` tagged templates to bind values — no raw user data in query text.
 */
function buildCursorSQL(cursorInfo: CursorInfo, parsedSort: SortField[], config: CursorSQLConfig): SQL | null {
	const primarySort = parsedSort[0]
	if (!primarySort) {
		return null
	}

	const sortCol = config.sortColumns[primarySort.field]
	const colRef = sortCol ? sql.raw(`${config.tableAlias}.${sortCol.name}`) : sql.raw(`${config.tableAlias}.createdAt`)
	const idRef = sql.raw(`${config.tableAlias}.${config.columns.id.name}`)

	const sortValue = cursorInfo.sortValue
	const idValue = cursorInfo.idValue

	if (cursorInfo.direction === "asc") {
		return sql`(${colRef} > ${sortValue} OR (${colRef} = ${sortValue} AND ${idRef} > ${idValue}))`
	}

	return sql`(${colRef} < ${sortValue} OR (${colRef} = ${sortValue} AND ${idRef} < ${idValue}))`
}

export { buildCursorSQL, type CursorSQLConfig }
