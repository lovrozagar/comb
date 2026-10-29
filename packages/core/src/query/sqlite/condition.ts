/**
 * One filter condition as SQL on one column: the single lowering filterToSQL (drizzle's columns)
 * and buildFilterSQL (a table alias's columns by name) share, so no operator or value conversion
 * exists in one and not the other (Q5 of r17). A column is described by what it stores (its kind)
 * and the SQL its values compare against.
 */
import {
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	ne,
	notInArray,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm"
import type { SQLiteColumn } from "drizzle-orm/sqlite-core"
import { IsoInstant } from "../iso-date.ts"
import type { FilterCondition } from "../types.ts"
import { patternToSQL } from "./pattern.ts"

/**
 * What a column stores, which decides how a validated value binds: text; a number (`numeric`, text
 * SQLite compares by number affinity); a date as epoch milliseconds or whole seconds; or `as-is`, a
 * value bound as validated (a boolean, JSON, or a raw column whose kind was not given)
 */
type ColumnKind = "as-is" | "date-ms" | "date-s" | "number" | "numeric" | "text"

/** A column a condition lowers onto: what it stores, and the SQL a value compares against */
type FilterColumn = {
	kind: ColumnKind
	/** a drizzle column binds a value through its own mapper; any other SQL binds it as it is */
	sql: SQLWrapper
}

/**
 * A drizzle column as a FilterColumn. A date column compares as the bare column, so its value binds
 * as the number it stores, not through drizzle's Date mapper
 */
function columnOf(column: SQLiteColumn): FilterColumn {
	const { dataType } = column
	if (dataType === "object date") {
		const seconds = (column as { mode?: unknown }).mode === "timestamp"
		return { kind: seconds ? "date-s" : "date-ms", sql: sql`${column}` }
	}
	if (dataType === "string numeric") return { kind: "numeric", sql: column }
	if (dataType.startsWith("string")) return { kind: "text", sql: column }
	if (dataType.startsWith("number")) return { kind: "number", sql: column }
	return { kind: "as-is", sql: column }
}

const isDate = (kind: ColumnKind): boolean => kind === "date-ms" || kind === "date-s"

/**
 * One value as `kind` stores it (Q5 of the 0.14.1 review, Q4 of r17): an ISO date field's instant
 * by its milliseconds on a date or number column, by its text on any other; a Date by its
 * milliseconds on a date column; any other value as validated
 */
function stored(value: unknown, kind: ColumnKind): unknown {
	if (value instanceof IsoInstant) return isDate(kind) || kind === "number" ? value.ms : value.text
	return value instanceof Date && isDate(kind) ? value.getTime() : value
}

/** Whether `value` is of `type`, or a list holding one */
const holds = (value: unknown, type: "number" | "string"): boolean =>
	typeof value === type || (Array.isArray(value) && value.some((member) => typeof member === type))

/**
 * Whether the value is one the column cannot compare: a number on a text column, which SQLite would
 * compare as text, or text on a date or number column, which it would compare as greater than every
 * number (U35). `numeric` compares both by its affinity (U35b). `is` and the patterns take text on
 * any column; `contains` reads a JSON array whatever the column is declared as (C13, 27.8).
 */
function mismatched(kind: ColumnKind, { operator, value }: FilterCondition): boolean {
	if (operator === "contains") return false
	if (kind === "text") return holds(value, "number")
	return (isDate(kind) || kind === "number") && !["ilike", "is", "like"].includes(operator) && holds(value, "string")
}

/**
 * The whole seconds of `members`, epoch milliseconds: what each matches on a seconds column, as
 * secondsBound rounds eq's value; one between two seconds matches no row, and is left out (U25)
 */
const wholeSeconds = (members: readonly unknown[]): number[] =>
	members.flatMap((ms) => (typeof ms === "number" && ms % 1000 === 0 ? [ms / 1000] : []))

/** The operators a date field takes with one number, which a seconds column rounds */
type SecondsOperator = "eq" | "gt" | "gte" | "lt" | "lte" | "ne" | "neq"
const isSecondsOperator = (operator: string): operator is SecondsOperator =>
	["eq", "gt", "gte", "lt", "lte", "ne", "neq"].includes(operator)

/**
 * How a seconds column compares with epoch milliseconds `ms` under `operator`: the comparison on
 * the whole second that keeps it exact (gt and lte on the second at or below, gte and lt on the one
 * at or above), or, for eq and ne on a value between two seconds, no row ("none") or every row that
 * has a value ("present")
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
 * A seconds column's condition on epoch milliseconds: one bound rounded as secondsBound keeps it
 * exact, or an in/nin list of each member as eq (in) or ne (nin) takes it (U25). Undefined for an
 * operator or value no rounding applies to
 */
function secondsSQL(column: SQLWrapper, operator: string, value: unknown): SQL | undefined {
	if ((operator === "in" || operator === "nin") && Array.isArray(value)) {
		const seconds = wholeSeconds(value)
		if (operator === "in") return seconds.length === 0 ? sql`0` : inArray(column, seconds)
		return seconds.length === 0 ? isNotNull(column) : notInArray(column, seconds)
	}
	if (!isSecondsOperator(operator) || typeof value !== "number") return undefined
	const bound = secondsBound(operator, value)
	if (bound === "none") return sql`0`
	if (bound === "present") return isNotNull(column)
	return { eq, gt, gte, lt, lte, ne }[bound.operator](column, bound.seconds)
}

/** `is`: null and notnull on any column, true and false on a boolean one (as validateFilter types them) */
function isToSQL(column: SQLWrapper, value: unknown): SQL | null {
	if (value === null) return isNull(column)
	if (value === "notnull") return isNotNull(column)
	return typeof value === "boolean" ? eq(column, value) : null
}

/** `operator` on `column` with a value as the column stores it; null for an operator it does not know */
function operatorSQL(column: SQLWrapper, operator: string, value: unknown): SQL | null {
	switch (operator) {
		case "eq":
			return eq(column, value)
		case "ne":
		case "neq":
			return ne(column, value)
		case "gt":
			return gt(column, value)
		case "gte":
			return gte(column, value)
		case "lt":
			return lt(column, value)
		case "lte":
			return lte(column, value)
		/* an empty in-list matches nothing and an empty nin-list everything, as drizzle writes them */
		case "in":
			return inArray(column, value as unknown[])
		case "nin":
			return notInArray(column, value as unknown[])
		case "like":
		case "ilike":
			return patternToSQL(column, operator, value)
		case "is":
			return isToSQL(column, value)
		/* a member of a JSON array the column holds, whatever it is declared as (C13, 27.8); a scalar JSON value is no set, though json_each reads it as one, and text that is no JSON, which json_type raises on, is matched by nothing: a CASE asks json_valid first, in the order SQLite evaluates it (27.15) */
		case "contains":
			return sql`(CASE WHEN json_valid(${column}) THEN json_type(${column}) = 'array' AND EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${value}) END)`
		default:
			return null
	}
}

/** One condition on one column; null when the operator or value is not one this column can take */
function lowerOn(column: FilterColumn, condition: FilterCondition): SQL | null {
	const { kind } = column
	const { operator } = condition
	const value = Array.isArray(condition.value)
		? condition.value.map((member) => stored(member, kind))
		: stored(condition.value, kind)
	if (mismatched(kind, { ...condition, value })) return null
	return (
		(kind === "date-s" ? secondsSQL(column.sql, operator, value) : undefined) ??
		operatorSQL(column.sql, operator, value)
	)
}

/** One condition on one drizzle column; null when the operator or value is not one this column can take */
const conditionToSQL = (condition: FilterCondition, column: SQLiteColumn): SQL | null =>
	lowerOn(columnOf(column), condition)

export { type ColumnKind, conditionToSQL, type FilterColumn, lowerOn }
