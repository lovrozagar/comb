/**
 * SQLite-specific query types.
 */
import type { SQLiteTable } from "drizzle-orm/sqlite-core"

/**
 * A many-to-many relation a filter reaches through a join table: `through.throughSourceKey`
 * references the main table's `sourceKey` (its primary key unless named), and
 * `through.throughTargetKey` references `target.targetKey`. Every key is a column's property name.
 */
type RelationConfig = {
	sourceKey?: string | undefined
	target: SQLiteTable
	targetKey: string
	through: SQLiteTable
	throughSourceKey: string
	throughTargetKey: string
}

export type { RelationConfig }
