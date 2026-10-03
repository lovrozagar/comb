/**
 * SQLite-specific query types.
 */
import type { SQLiteTable } from "drizzle-orm/sqlite-core"

type RelationConfig = {
	target: SQLiteTable
	targetKey: string
	through: SQLiteTable
	throughKey: string
}

export type { RelationConfig }
