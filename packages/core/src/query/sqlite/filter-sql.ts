/**
 * Raw SQL filter builders — table-alias-based SQL generation from FilterAST.
 * Used when building raw SQL queries (not Drizzle relational).
 */
import { type SQL, sql } from "drizzle-orm"

import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"

import type { FilterCondition, FilterGroup } from "../types.ts"
import { quoteIdent } from "./identifier.ts"
import { patternToSQL } from "./pattern.ts"

type FilterSQLConfig = {
	/** Column map: API field name -> SQL column name */
	columnMap: Record<string, string>
	/** Table alias used in query (e.g. "pc" for productCollection) */
	tableAlias: string
}

/**
 * A filter group as SQL, its conditions and subgroups joined by its logic; an empty group is the
 * identity of its logic: or() matches nothing, and() everything
 */
function buildFilterSQL(group: FilterGroup, config: FilterSQLConfig): SQL {
	const parts = [
		...group.conditions.map((condition) => requireConditionSQL(condition, config)),
		...group.subgroups.map((subgroup) => sql`(${buildFilterSQL(subgroup, config)})`),
	]
	if (parts.length === 0) return group.logic === "or" ? sql`0` : sql`1`

	const joinSQL = group.logic === "or" ? sql` OR ` : sql` AND `
	return sql.join(parts, joinSQL)
}

/** A condition every request filter must reach SQL as; dropping one would widen the result */
function requireConditionSQL(condition: FilterCondition, config: FilterSQLConfig): SQL {
	const built = buildConditionSQL(condition, config)
	if (built) return built
	throw new CombError({
		cause: `Filter on '${condition.field}' (${condition.operator}) has no mapped column to run it`,
		errorKey: combErrorKeys.FILTER_NOT_WIRED,
		status: "internal_server_error",
	})
}

/** A list of bound values; an empty in-list matches nothing and an empty nin-list everything */
function listSQL(column: SQL, value: unknown, negate: boolean): SQL {
	if (!Array.isArray(value) || value.length === 0) return negate ? sql`1` : sql`0`
	const placeholders = sql.join(
		value.map((v) => sql`${v}`),
		sql`, `,
	)
	return negate ? sql`${column} NOT IN (${placeholders})` : sql`${column} IN (${placeholders})`
}

function isSQL(column: SQL, value: unknown): SQL | null {
	if (value === null) return sql`${column} IS NULL`
	if (value === "notnull") return sql`${column} IS NOT NULL`
	return typeof value === "boolean" ? sql`${column} = ${value}` : null
}

type Lower = (column: SQL, value: unknown) => SQL | null

// lookup-table: each operator's lowering, so one condition is a single dispatch
const LOWER: Readonly<Partial<Record<FilterCondition["operator"], Lower>>> = {
	eq: (column, value) => sql`${column} = ${value}`,
	gt: (column, value) => sql`${column} > ${value}`,
	gte: (column, value) => sql`${column} >= ${value}`,
	ilike: (column, value) => patternToSQL(column, "ilike", value),
	in: (column, value) => listSQL(column, value, false),
	is: isSQL,
	like: (column, value) => patternToSQL(column, "like", value),
	lt: (column, value) => sql`${column} < ${value}`,
	lte: (column, value) => sql`${column} <= ${value}`,
	ne: (column, value) => sql`${column} != ${value}`,
	neq: (column, value) => sql`${column} != ${value}`,
	nin: (column, value) => listSQL(column, value, true),
}

/** One condition as SQL on its mapped column; null when the field is unmapped or the value unusable */
function buildConditionSQL(condition: FilterCondition, config: FilterSQLConfig): SQL | null {
	const colName = Object.hasOwn(config.columnMap, condition.field) ? config.columnMap[condition.field] : undefined
	const lower = Object.hasOwn(LOWER, condition.operator) ? LOWER[condition.operator] : undefined
	if (!colName || !lower) return null
	const column = sql`${sql.raw(quoteIdent(config.tableAlias))}.${sql.raw(quoteIdent(colName))}`
	return lower(column, condition.value)
}

export { buildConditionSQL, buildFilterSQL, type FilterSQLConfig }
