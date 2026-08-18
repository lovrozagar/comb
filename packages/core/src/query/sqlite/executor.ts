/**
 * SQLite query executor — Drizzle-native filter/sort/pagination orchestrator.
 */
import {
	and,
	asc,
	desc,
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

import { parseCursorForQuery } from "../cursor.ts"
import { parseFilter, parseOrder } from "../filter.ts"
import { likePattern } from "../like.ts"
import type {
	ComputedFilterResolver,
	ComputedSortResolver,
	FilterAST,
	FilterCondition,
	FilterGroup,
	ListQueryCapabilities,
	ListQueryInput,
	SortDirection,
	SortField,
} from "../types.ts"
import type { QueryExecutorConfig, QueryExecutorResult, RelationConfig } from "./types.ts"

const COMPUTED_PREFIX = "@"

type SortToSQLConfig = {
	capabilities: ListQueryCapabilities
	computedSorts?: Record<string, ComputedSortResolver> | undefined
	table: SQLiteTable
}

function sortToOrderBy(sortFields: SortField[], config: SortToSQLConfig): SQL[] {
	const orderBy: SQL[] = []

	for (const { direction, field } of sortFields) {
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

		orderBy.push(direction === "asc" ? asc(column) : desc(column))
	}

	return orderBy
}

function getDefaultSort(config: SortToSQLConfig): SQL[] {
	const columns = getTableColumns(config.table)
	const createdAtColumn = columns["createdAt"]
	if (createdAtColumn) {
		return [desc(createdAtColumn)]
	}
	return []
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
			return sql`${column} LIKE ${likePattern(String(value))} ESCAPE '\\'`
		case "ilike":
			return sql`${column} LIKE ${likePattern(String(value))} ESCAPE '\\' COLLATE NOCASE`
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

function resolveCondition(condition: FilterCondition, config: FilterToSQLConfig): SQL | null {
	const { field, operator, value } = condition

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
			return relationFilterToSQL(condition, relationConfig, config.mainTable)
		}
	}

	const columns = getTableColumns(config.mainTable)
	const column = columns[field]
	if (column) {
		return conditionToSQL(condition, column)
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

/**
 * Build query execution result from validated input.
 *
 * Orchestrates:
 * - Filter parsing and SQL generation
 * - Sort parsing and orderBy generation
 * - Cursor or offset pagination
 * - Computed filter/sort resolution
 */
class QueryExecutor {
	static build<TTable extends SQLiteTable>(config: QueryExecutorConfig<TTable>): QueryExecutorResult {
		const { capabilities, input, table } = config

		const whereClause = QueryExecutor.buildWhere(config)
		const { orderBy, primarySortDirection, primarySortField } = QueryExecutor.buildOrderBy(config)
		const { cursor, limit, meta, offset } = QueryExecutor.buildPagination(
			input,
			capabilities,
			primarySortField,
			primarySortDirection,
			table,
		)

		const cursorWhere = QueryExecutor.buildCursorWhere(cursor)
		let finalWhere: SQL | null = whereClause
		if (cursorWhere) {
			finalWhere = whereClause ? (and(whereClause, cursorWhere) ?? null) : cursorWhere
		}

		return {
			cursor,
			limit,
			meta,
			offset,
			orderBy,
			search: input.q?.trim() || null,
			where: finalWhere,
		}
	}

	private static buildWhere<TTable extends SQLiteTable>(config: QueryExecutorConfig<TTable>): SQL | null {
		const { capabilities, computedFilters, input, relations, table } = config

		if (!input.filter) {
			return null
		}

		const ast = parseFilter(input.filter)
		if (!ast) {
			return null
		}

		return filterToSQL(ast, {
			capabilities,
			computedFilters,
			mainTable: table,
			relations,
		})
	}

	private static buildOrderBy<TTable extends SQLiteTable>(
		config: QueryExecutorConfig<TTable>,
	): {
		orderBy: SQL[]
		primarySortDirection: SortDirection
		primarySortField: string
	} {
		const { capabilities, computedSorts, input, table } = config

		const sortFields = parseOrder(input.order)

		let orderBy: SQL[]
		let primarySortField = "createdAt"
		let primarySortDirection: SortDirection = "desc"

		if (sortFields.length > 0) {
			orderBy = sortToOrderBy(sortFields, {
				capabilities,
				computedSorts,
				table,
			})
			const first = sortFields[0]
			if (first) {
				primarySortField = first.field
				primarySortDirection = first.direction
			}
		} else {
			orderBy = getDefaultSort({ capabilities, table })
		}

		const columns = getTableColumns(table)
		const idColumn = columns["id"]
		if (idColumn && orderBy.length > 0) {
			orderBy.push(primarySortDirection === "desc" ? desc(idColumn) : asc(idColumn))
		}

		return { orderBy, primarySortDirection, primarySortField }
	}

	private static buildPagination<TTable extends SQLiteTable>(
		input: ListQueryInput,
		capabilities: ListQueryCapabilities,
		primarySortField: string,
		primarySortDirection: SortDirection,
		table: TTable,
	): {
		cursor: QueryExecutorResult["cursor"]
		limit: number
		meta: QueryExecutorResult["meta"]
		offset: number
	} {
		const { defaultLimit, maxLimit } = capabilities.pagination

		let limit = input.limit ?? defaultLimit
		limit = Math.max(1, Math.min(limit, maxLimit))

		const columns = getTableColumns(table)
		const idColumn = columns["id"]

		if (input.cursor && idColumn) {
			const cursorInfo = parseCursorForQuery(input.cursor, primarySortDirection)

			if (cursorInfo) {
				const sortColumn = primarySortField.startsWith("@") ? null : columns[primarySortField]

				return {
					cursor: sortColumn
						? {
								direction: primarySortDirection,
								idColumn,
								idValue: cursorInfo.idValue,
								sortColumn,
								sortValue: cursorInfo.sortValue,
							}
						: null,
					limit: limit + 1,
					meta: {
						limit,
						page: 1,
						type: "cursor",
					},
					offset: 0,
				}
			}
		}

		const page = Math.max(1, input.page ?? 1)
		const offset = (page - 1) * limit

		return {
			cursor: null,
			limit: limit + 1,
			meta: {
				limit,
				page,
				type: "offset",
			},
			offset,
		}
	}

	private static buildCursorWhere(cursor: QueryExecutorResult["cursor"]): SQL | null {
		if (!cursor) {
			return null
		}

		const { direction, idColumn, idValue, sortColumn, sortValue } = cursor

		if (direction === "desc") {
			const andClause = and(eq(sortColumn, sortValue), lt(idColumn, idValue))
			return or(lt(sortColumn, sortValue), andClause) ?? null
		}

		const andClause = and(eq(sortColumn, sortValue), gt(idColumn, idValue))
		return or(gt(sortColumn, sortValue), andClause) ?? null
	}
}

export { conditionToSQL, filterToSQL, QueryExecutor, sortToOrderBy }
