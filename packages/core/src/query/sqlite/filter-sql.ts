/**
 * Raw SQL filter builders — table-alias-based SQL generation from FilterAST, for raw SQL queries
 * (not Drizzle relational). Each condition lowers through condition.ts, as filterToSQL's do.
 */
import { type SQL, sql } from "drizzle-orm"

import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"

import type { FilterCondition, FilterGroup } from "../types.ts"
import { quoteIdent } from "./identifier.ts"
import { COLUMN_KINDS, type ColumnKind, lowerOn } from "./condition.ts"

/**
 * A mapped column: its name, its values bound as validated, or its name and what it stores, which
 * decides how a value binds as on a drizzle column (`"date-s"` for a date in whole seconds)
 */
type MappedColumn = string | { column: string; kind: ColumnKind }

type FilterSQLConfig = {
	/** Column map: API field name -> SQL column name, or `{ column, kind }` (condition.ts's ColumnKind) */
	columnMap: Record<string, MappedColumn>
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

/**
 * One condition as SQL on its mapped column, lowered as filterToSQL lowers it (Q5 of r17); null
 * when the field is unmapped or the column cannot take its operator or value
 */
function buildConditionSQL(condition: FilterCondition, config: FilterSQLConfig): SQL | null {
	const mapped = Object.hasOwn(config.columnMap, condition.field) ? config.columnMap[condition.field] : undefined
	if (mapped === undefined) return null
	const { column, kind } = typeof mapped === "string" ? { column: mapped, kind: "as-is" as const } : mapped
	/* a kind comb does not know, as JavaScript may still pass the shape before 0.16, would bind as text: refused */
	if (!COLUMN_KINDS.includes(kind))
		throw new TypeError(
			`buildFilterSQL: columnMap.${condition.field} has no kind comb knows (${COLUMN_KINDS.join(", ")}); \`unit: "s"\` is \`kind: "date-s"\` since 0.16`,
		)
	return lowerOn(
		{ kind, sql: sql`${sql.raw(quoteIdent(config.tableAlias))}.${sql.raw(quoteIdent(column))}` },
		condition,
	)
}

export { buildConditionSQL, buildFilterSQL, type FilterSQLConfig, type MappedColumn }
