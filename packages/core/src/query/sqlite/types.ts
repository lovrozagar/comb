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
	/** the main table's key the join table references; default its single primary key, and a filter on a table with none or several is a 500 */
	sourceKey?: string | undefined
	/** the table the filtered column is on */
	target: SQLiteTable
	/** the target's key the join table references */
	targetKey: string
	/** the join table */
	through: SQLiteTable
	/** the join table's column holding the main table's key */
	throughSourceKey: string
	/** the join table's column holding the target's key */
	throughTargetKey: string
}

export type { RelationConfig }
