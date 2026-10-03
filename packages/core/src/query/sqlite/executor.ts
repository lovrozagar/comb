/**
 * SQLite query executor — Drizzle-native filter/sort/pagination orchestrator.
 */
import {
	and,
	eq,
	getTableColumns,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	ne,
	notInArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"

import { coerceFilterValue } from "../filter.ts"
import type {
	ComputedFilterResolver,
	ComputedSortResolver,
	FieldType,
	FilterAST,
	FilterCondition,
	FilterGroup,
	ListQueryCapabilities,
	SortField,
} from "../types.ts"
import { orderSQL } from "./keyset.ts"
import { patternToSQL } from "./pattern.ts"
import type { RelationConfig } from "./types.ts"

const COMPUTED_PREFIX = "@"

type SortToSQLConfig = {
	capabilities: ListQueryCapabilities
	computedSorts?: Record<string, ComputedSortResolver> | undefined
	table: SQLiteTable
}

function sortToOrderBy(sortFields: SortField[], config: SortToSQLConfig): SQL[] {
	const orderBy: SQL[] = []

	for (const { direction, field, nulls } of sortFields) {
		if (field.startsWith(COMPUTED_PREFIX)) {
			const resolver = config.computedSorts?.[field]
			if (resolver) {
				orderBy.push(resolver(direction))
			}
			continue
		}

		if (!config.capabilities.sortFields.has(field)) {
			continue
		}

		const columns = getTableColumns(config.table)
		const column = columns[field]
		if (!column) {
			continue
		}

		orderBy.push(orderSQL({ column, direction, nulls }))
	}

	return orderBy
}

function conditionToSQL(condition: FilterCondition, column: SQLiteColumn): SQL | null {
	const { operator, value } = condition

	switch (operator) {
		case "eq":
			return eq(column, value)
		case "ne":
		case "neq":
			return ne(column, value)
		case "gt":
			return gt(column, value as number | string)
		case "gte":
			return gte(column, value as number | string)
		case "lt":
			return lt(column, value as number | string)
		case "lte":
			return lte(column, value as number | string)
		case "in":
			return inArray(column, value as unknown[])
		case "nin":
			return notInArray(column, value as unknown[])
		case "like":
		case "ilike":
			return patternToSQL(column, operator, value)
		case "is":
			if (value === null) {
				return isNull(column)
			}
			if (value === "notnull") {
				return isNotNull(column)
			}
			return null
		default:
			return null
	}
}

type FilterToSQLConfig = {
	capabilities: ListQueryCapabilities
	computedFilters?: Record<string, ComputedFilterResolver> | undefined
	mainTable: SQLiteTable
	relations?: Record<string, RelationConfig> | undefined
}

function relationFilterToSQL(
	condition: FilterCondition,
	relationConfig: RelationConfig,
	mainTable: SQLiteTable,
): SQL | null {
	const { field, operator, value } = condition

	const fieldParts = field.split(".")
	if (fieldParts.length < 2) return null

	const targetFieldName = fieldParts[fieldParts.length - 1]
	if (!targetFieldName) return null

	const targetColumns = getTableColumns(relationConfig.target)
	const targetColumn = targetColumns[targetFieldName]
	if (!targetColumn) return null

	const mainColumns = getTableColumns(mainTable)
	const throughColumns = getTableColumns(relationConfig.through)

	const mainIdColumn = mainColumns["id"]
	const throughColumn = throughColumns[relationConfig.throughKey]
	const targetIdColumn = targetColumns[relationConfig.targetKey]
	const throughTargetKeyAlt = `${relationConfig.targetKey.replace("Id", "")}Id`
	const throughTargetColumn = throughColumns[throughTargetKeyAlt] || throughColumns[relationConfig.targetKey]

	const targetCondition = conditionToSQL({ field: targetFieldName, operator, value }, targetColumn)
	if (!targetCondition) return null

	return sql`EXISTS (
		SELECT 1 FROM ${relationConfig.through}
		INNER JOIN ${relationConfig.target} ON ${targetIdColumn} = ${throughTargetColumn}
		WHERE ${throughColumn} = ${mainIdColumn}
		AND ${targetCondition}
	)`
}

function fieldTypeOf(field: string, config: FilterToSQLConfig): FieldType | undefined {
	return (
		config.capabilities.filterFields[field] ??
		config.capabilities.computedFilterFields[field] ??
		config.capabilities.relationFilterFields[field]
	)
}

function typedCondition(condition: FilterCondition, config: FilterToSQLConfig): FilterCondition {
	const fieldType = fieldTypeOf(condition.field, config)
	if (!fieldType) return condition
	return { ...condition, value: coerceFilterValue(fieldType, condition.value) }
}

function resolveCondition(condition: FilterCondition, config: FilterToSQLConfig): SQL | null {
	const { field, operator, value } = typedCondition(condition, config)

	if (field.startsWith(COMPUTED_PREFIX)) {
		const resolver = config.computedFilters?.[field]
		if (resolver) {
			return resolver(operator, value)
		}
		return null
	}

	const dotIndex = field.indexOf(".")
	if (dotIndex > 0) {
		const relationName = field.substring(0, dotIndex)
		const relationConfig = config.relations?.[relationName]
		if (relationConfig) {
			return relationFilterToSQL({ field, operator, value }, relationConfig, config.mainTable)
		}
	}

	const columns = getTableColumns(config.mainTable)
	const column = columns[field]
	if (column) {
		return conditionToSQL({ field, operator, value }, column)
	}

	return null
}

function groupToSQL(group: FilterGroup, config: FilterToSQLConfig): SQL | null {
	const conditions: SQL[] = []

	for (const condition of group.conditions) {
		const sqlCondition = resolveCondition(condition, config)
		if (sqlCondition) {
			conditions.push(sqlCondition)
		}
	}

	for (const subgroup of group.subgroups) {
		const subgroupSQL = groupToSQL(subgroup, config)
		if (subgroupSQL) {
			conditions.push(subgroupSQL)
		}
	}

	if (conditions.length === 0) {
		return null
	}

	const first = conditions[0]
	if (conditions.length === 1 && first) {
		return first
	}

	const result = group.logic === "and" ? and(...conditions) : or(...conditions)
	return result ?? null
}

function filterToSQL(ast: FilterAST | null, config: FilterToSQLConfig): SQL | null {
	if (!ast) {
		return null
	}

	return groupToSQL(ast.root, config)
}

export { conditionToSQL, filterToSQL, sortToOrderBy }
