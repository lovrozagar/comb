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
 * A mapped column: its name and what it stores, which decides how a value binds as on a drizzle
 * column (`"date-s"` for a date in whole seconds, `"as-is"` for its values bound as validated)
 */
type MappedColumn = {
	/** the column's SQL name, quoted as an identifier under the table alias */
	column: string
	/** what the column stores */
	kind: ColumnKind
}

/** How `buildFilterSQL` and `buildConditionSQL` reach the columns of a raw SQL query */
type FilterSQLConfig = {
	/** each filter field's column, by its name in the API; a filter on a field it lacks is a 500 */
	columnMap: Record<string, MappedColumn>
	/** the alias the query reads the table under, such as "pc" for productCollection */
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

// Q5 of r17
/**
 * One condition as SQL on its mapped column, lowered as filterToSQL lowers it; null when the field
 * is unmapped or the column cannot take its operator or value. A mapping that is no
 * `{ column, kind }` with a known kind throws a TypeError
 */
function buildConditionSQL(condition: FilterCondition, config: FilterSQLConfig): SQL | null {
	const mapped = Object.hasOwn(config.columnMap, condition.field) ? config.columnMap[condition.field] : undefined
	if (mapped === undefined) return null
	/* a bare column name, the string form before 0.17, which JavaScript may still pass, is refused (Q5 of r18) */
	if (typeof mapped === "string")
		throw new TypeError(
			`buildFilterSQL: columnMap.${condition.field} is a bare column name; \`${JSON.stringify(mapped)}\` is \`{ column: ${JSON.stringify(mapped)}, kind: "as-is" }\` since 0.17`,
		)
	const { column, kind } = mapped
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
