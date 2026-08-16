/**
 * Raw SQL filter builders — table-alias-based SQL generation from FilterAST.
 * Used when building raw SQL queries (not Drizzle relational).
 */
import { sql } from "drizzle-orm"

import type { FilterCondition, FilterGroup } from "../types.ts"

type FilterSQLConfig = {
	/** Column map: API field name -> SQL column name */
	columnMap: Record<string, string>
	/** Table alias used in query (e.g. "pc" for productCollection) */
	tableAlias: string
}

/**
 * Build SQL fragment from filter AST group.
 * Recursively processes conditions and subgroups with AND/OR logic.
 */
function buildFilterSQL(group: FilterGroup, config: FilterSQLConfig): ReturnType<typeof sql> | null {
	const parts: Array<ReturnType<typeof sql>> = []

	for (const condition of group.conditions) {
		const conditionSQL = buildConditionSQL(condition, config)
		if (conditionSQL) {
			parts.push(conditionSQL)
		}
	}

	for (const subgroup of group.subgroups) {
		const subgroupSQL = buildFilterSQL(subgroup, config)
		if (subgroupSQL) {
			parts.push(sql`(${subgroupSQL})`)
		}
	}

	if (parts.length === 0) {
		return null
	}

	const joinSQL = group.logic === "or" ? sql` OR ` : sql` AND `
	return sql.join(parts, joinSQL)
}

function buildConditionSQL(condition: FilterCondition, config: FilterSQLConfig): ReturnType<typeof sql> | null {
	const colName = config.columnMap[condition.field]
	if (!colName) {
		return null
	}

	const column = sql.raw(`${config.tableAlias}.${colName}`)

	switch (condition.operator) {
		case "eq":
			return sql`${column} = ${condition.value}`
		case "ne":
		case "neq":
			return sql`${column} != ${condition.value}`
		case "gt":
			return sql`${column} > ${condition.value}`
		case "gte":
			return sql`${column} >= ${condition.value}`
		case "lt":
			return sql`${column} < ${condition.value}`
		case "lte":
			return sql`${column} <= ${condition.value}`
		case "in": {
			if (!Array.isArray(condition.value) || condition.value.length === 0) {
				return null
			}
			const placeholders = condition.value.map((v) => sql`${v}`)
			return sql`${column} IN (${sql.join(placeholders, sql`, `)})`
		}
		case "nin": {
			if (!Array.isArray(condition.value) || condition.value.length === 0) {
				return null
			}
			const placeholders = condition.value.map((v) => sql`${v}`)
			return sql`${column} NOT IN (${sql.join(placeholders, sql`, `)})`
		}
		case "like":
			return sql`${column} LIKE ${condition.value}`
		case "ilike":
			return sql`${column} LIKE ${condition.value} COLLATE NOCASE`
		case "is":
			if (condition.value === null) {
				return sql`${column} IS NULL`
			}
			if (condition.value === "notnull") {
				return sql`${column} IS NOT NULL`
			}
			return null
		default:
			return null
	}
}

export { buildConditionSQL, buildFilterSQL, type FilterSQLConfig }
