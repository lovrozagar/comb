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

import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"
import type {
	ComputedFilterResolver,
	ComputedSortResolver,
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

/** `record[key]` when it is the record's own entry, never one inherited from Object.prototype */
const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined =>
	record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined

type SortToSQLConfig = {
	capabilities: ListQueryCapabilities
	computedSorts?: Record<string, ComputedSortResolver> | undefined
	table: SQLiteTable
}

function sortToOrderBy(sortFields: SortField[], config: SortToSQLConfig): SQL[] {
	const orderBy: SQL[] = []

	for (const { direction, field, nulls } of sortFields) {
		if (field.startsWith(COMPUTED_PREFIX)) {
			const resolver = own(config.computedSorts, field)
			if (resolver) {
				orderBy.push(resolver(direction))
			}
			continue
		}

		if (!config.capabilities.sortFields.has(field)) {
			continue
		}

		const column = own(getTableColumns(config.table) as Record<string, SQLiteColumn>, field)
		if (!column) continue

		orderBy.push(orderSQL({ column, direction, nulls }))
	}

	return orderBy
}

/** `is`: null and notnull on any column, true and false on a boolean one (as validateFilter types them) */
function isToSQL(column: SQLiteColumn, value: unknown): SQL | null {
	if (value === null) return isNull(column)
	if (value === "notnull") return isNotNull(column)
	return typeof value === "boolean" ? eq(column, value) : null
}

/** One condition on one column; null when the operator or value is not one this column can take */
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
			return isToSQL(column, value)
		default:
			return null
	}
}

/**
 * What a validated filter lowers against. Values arrive typed by `validateFilter` (or the list
 * query schema), so they bind as the field declares.
 */
type FilterToSQLConfig = {
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
	const targetFieldName = field.slice(field.lastIndexOf(".") + 1)
	const targetColumns = getTableColumns(relationConfig.target)
	const targetColumn = own(targetColumns, targetFieldName)
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

/** The condition's SQL, or null when nothing in `config` can express it */
function lowerCondition(condition: FilterCondition, config: FilterToSQLConfig): SQL | null {
	const { field, operator, value } = condition
	if (field.startsWith(COMPUTED_PREFIX)) return own(config.computedFilters, field)?.(operator, value) ?? null
	const dotIndex = field.indexOf(".")
	const relation = dotIndex > 0 ? own(config.relations, field.slice(0, dotIndex)) : undefined
	if (relation) return relationFilterToSQL(condition, relation, config.mainTable)
	const column = own(getTableColumns(config.mainTable) as Record<string, SQLiteColumn>, field)
	return column ? conditionToSQL(condition, column) : null
}

/**
 * A condition the schema accepted must reach the WHERE clause. Dropping one would answer the
 * request with more rows than it asked for, so a condition nothing can express is a wiring
 * mistake in the handler: a missing resolver or relation, or a resolver declining the operator.
 */
function resolveCondition(condition: FilterCondition, config: FilterToSQLConfig): SQL {
	const lowered = lowerCondition(condition, config)
	if (lowered) return lowered
	throw new CombError({
		cause: `Filter on '${condition.field}' (${condition.operator}) has no column, relation or resolver to run it`,
		errorKey: combErrorKeys.FILTER_NOT_WIRED,
		status: "internal_server_error",
	})
}

function groupToSQL(group: FilterGroup, config: FilterToSQLConfig): SQL | null {
	const conditions = [
		...group.conditions.map((condition) => resolveCondition(condition, config)),
		...group.subgroups.map((subgroup) => groupToSQL(subgroup, config)).filter((part): part is SQL => part !== null),
	]
	if (conditions.length <= 1) return conditions[0] ?? null
	/* and() and or() return undefined only for an empty list, and this one holds two or more */
	return (group.logic === "and" ? and(...conditions) : or(...conditions)) as SQL
}

function filterToSQL(ast: FilterAST | null, config: FilterToSQLConfig): SQL | null {
	return ast ? groupToSQL(ast.root, config) : null
}

export { conditionToSQL, filterToSQL, sortToOrderBy, type FilterToSQLConfig }
