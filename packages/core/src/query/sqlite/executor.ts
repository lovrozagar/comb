/**
 * SQLite query executor — Drizzle-native filter/sort/pagination orchestrator.
 */
import { and, getTableColumns, getTableName, or, type SQL, sql } from "drizzle-orm"
import { alias, type SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core"

import { own } from "../../constraint-map.ts"
import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"
import type { ComputedFilterResolver, FilterAST, FilterCondition, FilterGroup } from "../types.ts"
import { conditionToSQL } from "./condition.ts"
import type { RelationConfig } from "./types.ts"

const COMPUTED_PREFIX = "@"

/**
 * What a validated filter lowers against. Values arrive typed by `validateFilter` (or the list
 * query schema), so they bind as the field declares.
 */
type FilterToSQLConfig = {
	computedFilters?: Record<string, ComputedFilterResolver> | undefined
	mainTable: SQLiteTable
	relations?: Record<string, RelationConfig> | undefined
}

/**
 * `table` under `name`: its columns qualified by the alias, and the `<table> AS <name>` the
 * EXISTS reads it through, so no table of the subquery shadows the outer row
 */
function aliasedColumns(table: SQLiteTable, name: string): { columns: Record<string, SQLiteColumn>; from: SQL } {
	const aliased = alias(table, name) as unknown as Record<string, SQLiteColumn>
	const columns = Object.fromEntries(Object.keys(getTableColumns(table)).map((key) => [key, aliased[key]]))
	return {
		columns: columns as Record<string, SQLiteColumn>,
		from: sql`${sql.identifier(getTableName(table))} AS ${sql.identifier(name)}`,
	}
}

/**
 * A negative operator's positive, which a relation filter reads as "no related row matches it"
 * (U30): ne and nin as no related row equal to or in the value, is.null as no related row with a
 * value, is.notnull as no related row without one. undefined for an operator that is its own positive.
 */
function positiveOf({ operator, value }: FilterCondition): Pick<FilterCondition, "operator" | "value"> | undefined {
	if (operator === "ne" || operator === "neq") return { operator: "eq", value }
	if (operator === "nin") return { operator: "in", value }
	if (operator === "is" && value === null) return { operator: "is", value: "notnull" }
	if (operator === "is" && value === "notnull") return { operator: "is", value: null }
	return undefined
}

function relationFilterToSQL(
	condition: FilterCondition,
	relationConfig: RelationConfig,
	mainTable: SQLiteTable,
): SQL | null {
	const targetFieldName = condition.field.slice(condition.field.lastIndexOf(".") + 1)
	/* aliased, as a relation back to the main table would otherwise read its own key for the outer row's */
	const target = aliasedColumns(relationConfig.target, "comb_rel_target")
	const through = aliasedColumns(relationConfig.through, "comb_rel_through")
	const targetColumns = target.columns
	const targetColumn = own(targetColumns, targetFieldName)
	if (!targetColumn) return null

	const mainColumns = getTableColumns(mainTable)
	const throughColumns = through.columns
	/* the main table's key: the one named, else its single primary key */
	const primary = Object.keys(mainColumns).filter((key) => (mainColumns[key] as SQLiteColumn).primary)
	const sourceKey = relationConfig.sourceKey ?? (primary.length === 1 ? primary[0] : undefined)
	const sourceColumn = sourceKey === undefined ? undefined : own(mainColumns, sourceKey)
	const throughSourceColumn = own(throughColumns, relationConfig.throughSourceKey)
	const throughTargetColumn = own(throughColumns, relationConfig.throughTargetKey)
	const targetKeyColumn = own(targetColumns, relationConfig.targetKey)
	if (!sourceColumn || !throughSourceColumn || !throughTargetColumn || !targetKeyColumn) return null

	const positive = positiveOf(condition)
	const targetCondition = conditionToSQL({ ...condition, ...positive, field: targetFieldName }, targetColumn)
	if (!targetCondition) return null

	return sql`${positive === undefined ? sql`` : sql`NOT `}EXISTS (
		SELECT 1 FROM ${through.from}
		INNER JOIN ${target.from} ON ${targetKeyColumn} = ${throughTargetColumn}
		WHERE ${throughSourceColumn} = ${sourceColumn}
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

/** A group as SQL; an empty one is the identity of its logic: or() matches nothing, and() everything */
function groupToSQL(group: FilterGroup, config: FilterToSQLConfig): SQL {
	const conditions = [
		...group.conditions.map((condition) => resolveCondition(condition, config)),
		...group.subgroups.map((subgroup) => groupToSQL(subgroup, config)),
	]
	if (conditions.length === 0) return group.logic === "or" ? sql`0` : sql`1`
	if (conditions.length === 1) return conditions[0] as SQL
	/* and() and or() return undefined only for an empty list, and this one holds two or more */
	return (group.logic === "and" ? and(...conditions) : or(...conditions)) as SQL
}

function filterToSQL(ast: FilterAST | null, config: FilterToSQLConfig): SQL | null {
	return ast ? groupToSQL(ast.root, config) : null
}

export { conditionToSQL, filterToSQL, type FilterToSQLConfig }
