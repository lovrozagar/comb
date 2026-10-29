/**
 * SQLite query executor — Drizzle-native filter/sort/pagination orchestrator.
 */
import {
	and,
	eq,
	getTableColumns,
	getTableName,
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
import { alias, type SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core"

import { own } from "../../constraint-map.ts"
import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"
import type { ComputedFilterResolver, FilterAST, FilterCondition, FilterGroup } from "../types.ts"
import { patternToSQL } from "./pattern.ts"
import { asStored } from "./stored-value.ts"
import type { RelationConfig } from "./types.ts"

const COMPUTED_PREFIX = "@"

/** `is`: null and notnull on any column, true and false on a boolean one (as validateFilter types them) */
function isToSQL(column: SQLiteColumn, value: unknown): SQL | null {
	if (value === null) return isNull(column)
	if (value === "notnull") return isNotNull(column)
	return typeof value === "boolean" ? eq(column, value) : null
}

/**
 * A validated value as `column` binds it: a date field's epoch milliseconds become a Date on a
 * date column, so drizzle writes them in the unit the column stores (seconds or milliseconds)
 */
function boundValue(column: SQLiteColumn, value: unknown): unknown {
	if (column.dataType !== "object date") return value
	/* an in/nin list's members each as one value is (U25): a date field's are numbers, as validated */
	if (Array.isArray(value)) return value.map((member) => new Date(member as number))
	return typeof value === "number" ? new Date(value) : value
}

/**
 * The whole seconds of `members`, epoch milliseconds: what each matches on a seconds column, as
 * secondsBound rounds eq's value; one between two seconds matches no row, and is left out (U25)
 */
const wholeSeconds = (members: readonly unknown[]): number[] =>
	members.flatMap((ms) => (typeof ms === "number" && ms % 1000 === 0 ? [ms / 1000] : []))

/** Whether a date column stores whole seconds: drizzle's integer `timestamp` mode, which binds `floor(ms / 1000)` */
const inSeconds = (column: SQLiteColumn): boolean =>
	column.dataType === "object date" && (column as { mode?: unknown }).mode === "timestamp"

/** The operators a date field takes with one number, which a seconds column rounds */
type SecondsOperator = "eq" | "gt" | "gte" | "lt" | "lte" | "ne" | "neq"
// lookup-table: the comparison operators secondsCondition rounds
const SECONDS_OPERATORS: ReadonlySet<SecondsOperator> = /* @__PURE__ */ new Set<SecondsOperator>([
	"eq",
	"gt",
	"gte",
	"lt",
	"lte",
	"ne",
	"neq",
])
const isSecondsOperator = (operator: string): operator is SecondsOperator =>
	SECONDS_OPERATORS.has(operator as SecondsOperator)

/**
 * A seconds column's condition on epoch milliseconds, each bound rounded the way that keeps it
 * exact: gt and lte on the second at or below, gte and lt on the second at or above; eq and ne on
 * a value between two seconds match no row and every row that has one
 */
function secondsCondition(column: SQLiteColumn, operator: SecondsOperator, ms: number): SQL {
	const bound = secondsBound(operator, ms)
	if (bound === "none") return sql`0`
	if (bound === "present") return isNotNull(column)
	const at = new Date(bound.seconds * 1000)
	const compare = { eq, gt, gte, lt, lte, ne }[bound.operator]
	return compare(column, at)
}

/**
 * How a seconds column compares with epoch milliseconds `ms` under `operator`: the comparison on
 * the whole second that keeps it exact, or, for eq and ne on a value between two seconds, no row
 * ("none") or every row that has a value ("present"). The raw builder binds the seconds as they are.
 */
function secondsBound(
	operator: SecondsOperator,
	ms: number,
): "none" | "present" | { operator: "eq" | "gt" | "gte" | "lt" | "lte" | "ne"; seconds: number } {
	const below = Math.floor(ms / 1000)
	const above = Math.ceil(ms / 1000)
	const whole = ms % 1000 === 0
	if (operator === "gt" || operator === "lte") return { operator, seconds: below }
	if (operator === "gte" || operator === "lt") return { operator, seconds: above }
	if (operator === "eq") return whole ? { operator, seconds: below } : "none"
	return whole ? { operator: "ne", seconds: below } : "present"
}

/**
 * A seconds column's in/nin on epoch milliseconds, each member as eq (in) or ne (nin) takes it:
 * a member between two seconds matches no row, so in on none of a whole second matches nothing,
 * and nin of none leaves every row that has a value (U25)
 */
function secondsList(column: SQLiteColumn, operator: "in" | "nin", members: readonly unknown[]): SQL {
	const dates = wholeSeconds(members).map((seconds) => new Date(seconds * 1000))
	if (operator === "in") return dates.length === 0 ? sql`0` : inArray(column, dates)
	return dates.length === 0 ? isNotNull(column) : notInArray(column, dates)
}

/** Whether `value` is of `type`, or a list holding one */
const holds = (value: unknown, type: "number" | "string"): boolean =>
	typeof value === type || (Array.isArray(value) && value.some((member) => typeof member === type))

/**
 * Whether the condition's value is one `column` cannot compare: a number on a text column, which
 * SQLite would compare as text, or text (an ISO date field's) on a date column, whose mapper takes
 * a Date, or on a number column, which would compare it as text (U35). `numeric()`, "string
 * numeric" to drizzle, compares both as numbers by its affinity (U35b). `is` and the patterns take
 * text on any column.
 */
const mismatched = (column: SQLiteColumn, { operator, value }: FilterCondition): boolean =>
	column.dataType.startsWith("string")
		? column.dataType !== "string numeric" && holds(value, "number")
		: (column.dataType === "object date" || column.dataType.startsWith("number")) &&
			!["ilike", "is", "like"].includes(operator) &&
			holds(value, "string")

/** One condition on one column; null when the operator or value is not one this column can take */
function conditionToSQL(given: FilterCondition, column: SQLiteColumn): SQL | null {
	const condition = asStored(given, column)
	if (condition.operator !== "contains" && mismatched(column, condition)) return null
	const { operator } = condition
	if (inSeconds(column) && (operator === "in" || operator === "nin") && Array.isArray(condition.value))
		return secondsList(column, operator, condition.value)
	const seconds =
		inSeconds(column) && isSecondsOperator(operator) && typeof condition.value === "number"
			? secondsCondition(column, operator, condition.value)
			: undefined
	return seconds ?? operatorSQL(column, operator, boundValue(column, condition.value))
}

/** `operator` on `column` with a value already bound as the column takes it; null for an operator it does not know */
function operatorSQL(column: SQLiteColumn, operator: string, value: unknown): SQL | null {
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
		/* a member of a JSON array the column holds, whatever it is declared as, so mismatched() does not apply (C13, 27.8); a scalar JSON value is no set, though json_each reads it as one */
		case "contains":
			return sql`(json_type(${column}) = 'array' AND EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${value}))`
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

export { conditionToSQL, filterToSQL, type FilterToSQLConfig, isSecondsOperator, secondsBound, wholeSeconds }
