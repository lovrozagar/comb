/**
 * Validating a filter against the fields an endpoint declares. A valid filter comes back with
 * every value typed as its field declares, so SQL generation binds numbers as numbers and
 * booleans as booleans, and computed resolvers receive the declared type.
 */
import { parseFilter } from "./filter-parse.ts"
import { type CheckedField, typedValue } from "./filter-typed.ts"
import { patternOf } from "./like.ts"
import type { FieldType, FilterAST, FilterCondition, FilterGroup, FilterOperator } from "./types.ts"

const OPERATORS_BY_TYPE: Record<FieldType, readonly FilterOperator[]> = {
	boolean: ["eq", "ne", "neq", "is"],
	date: ["eq", "ne", "neq", "gt", "gte", "lt", "lte", "is"],
	enum: ["eq", "ne", "neq", "in", "nin", "is"],
	number: ["eq", "ne", "neq", "gt", "gte", "lt", "lte", "in", "nin", "is"],
	string: ["eq", "ne", "neq", "like", "ilike", "in", "nin", "is"],
} as const

/**
 * What a field's spec may list beyond its type's defaults: contains on any type, its value one
 * scalar of the type (an element of an array or multi-select column), and the ordered comparisons
 * on a string, which compare text: an ISO instant written in two offsets sorts wrong as text
 */
const TYPABLE_BY_TYPE: Record<FieldType, readonly FilterOperator[]> = {
	boolean: [...OPERATORS_BY_TYPE.boolean, "contains"],
	date: [...OPERATORS_BY_TYPE.date, "in", "nin", "contains"],
	enum: [...OPERATORS_BY_TYPE.enum, "contains"],
	number: [...OPERATORS_BY_TYPE.number, "contains"],
	string: [...OPERATORS_BY_TYPE.string, "gt", "gte", "lt", "lte", "contains"],
}

/**
 * A field as a runtime field map declares it: its type, the operators it takes when not its
 * type's (`OPERATORS_BY_TYPE`), and for a date, `format: "iso"` to take ISO 8601 text, as a
 * column that stores it holds, in place of epoch milliseconds
 */
type FilterFieldSpec = {
	format?: "iso" | undefined
	operators?: readonly FilterOperator[] | undefined
	type: FieldType
}

/** A field of `validateFilter`'s map: a bare type, or a spec */
type FilterField = FieldType | FilterFieldSpec

type FilterValidationResult = { ast: FilterAST; valid: true } | { errors: string[]; valid: false }

/** Bounds on one filter expression. Each condition is a predicate SQLite evaluates per row. */
type FilterLimits = {
	maxConditions: number
	/** Nested or()/and() groups below the top level */
	maxDepth: number
	maxInValues: number
	/** Bytes of a like or ilike pattern, a value with an inner `*`, once escaped: D1 caps a pattern at 50 */
	maxPatternBytes: number
	/** Values the whole filter binds, every in/nin member counted: D1 binds at most 100 per statement */
	maxValues: number
}

const FILTER_LIMITS: FilterLimits = {
	maxConditions: 20,
	maxDepth: 3,
	maxInValues: 50,
	maxPatternBytes: 50,
	maxValues: 60,
}

/** A limits bag as a caller gives it: any key left out or set to undefined keeps its default (KT1 of r22b) */
type LimitsGiven<T> = { [K in keyof T]?: number | undefined }

/**
 * `given` over `defaults`, a key set to undefined left out as every other option bag reads it, each
 * other a whole number from 0, a TypeError naming it and `owner` otherwise (KT1 of r22b): a cap of
 * NaN or undefined compared false, which turned it off. No cap is a large whole number
 */
function limitsOver<T extends Record<string, number>>(
	owner: string,
	defaults: T,
	given: LimitsGiven<T> | undefined,
): T {
	const set = Object.entries(given ?? {}).filter((entry): entry is [string, number] => entry[1] !== undefined)
	for (const [key, value] of set) {
		if (!Number.isSafeInteger(value) || value < 0)
			throw new TypeError(`${owner}: limits.${key} must be a whole number from 0; got ${String(value)}`)
	}
	return { ...defaults, ...Object.fromEntries(set) }
}

/** The parameters one condition binds */
const boundBy = ({ operator, value }: FilterCondition) =>
	Array.isArray(value) ? value.length : operator === "is" && typeof value !== "boolean" ? 0 : 1

type Check = { errors: string[]; fields: Record<string, CheckedField>; limits: FilterLimits }

/** Each field with its operators resolved; a TypeError for a spec its type cannot take, a caller's mistake */
function checkedFields(fields: Record<string, FilterField>): Record<string, CheckedField> {
	const checked: Record<string, CheckedField> = {}
	for (const [name, field] of Object.entries(fields)) {
		const { format, operators, type } = typeof field === "string" ? { type: field } : (field as FilterFieldSpec)
		if (format !== undefined && (format !== "iso" || type !== "date"))
			throw new TypeError(`validateFilter: field '${name}' has format '${format}', which only a date field takes`)
		const misfit = operators?.find((operator) => !TYPABLE_BY_TYPE[type].includes(operator))
		if (misfit !== undefined)
			throw new TypeError(
				`validateFilter: field '${name}' lists operator '${misfit}', which a ${type} field cannot take`,
			)
		Object.defineProperty(checked, name, {
			enumerable: true,
			value: { format, operators: operators ?? OPERATORS_BY_TYPE[type], type },
		})
	}
	return checked
}

/** A like or ilike pattern past maxPatternBytes, as SQLite reads it, escaped: D1 refuses it only once it evaluates a row (Q8) */
function refuseLongPattern({ field, operator, value }: FilterCondition, check: Check): void {
	if ((operator !== "like" && operator !== "ilike") || typeof value !== "string") return
	const pattern = patternOf(operator, value)
	const bytes = pattern === null ? 0 : new TextEncoder().encode(pattern).length
	if (bytes > check.limits.maxPatternBytes)
		check.errors.push(
			`Filter pattern too long for '${field}': ${bytes} bytes once escaped (max ${check.limits.maxPatternBytes})`,
		)
}

function checkCondition(condition: FilterCondition, check: Check): FilterCondition {
	const { field, operator } = condition
	if (!Object.hasOwn(check.fields, field)) {
		check.errors.push(`Unknown filter field: ${field}`)
		return condition
	}
	const spec = check.fields[field] as CheckedField
	if (!spec.operators.includes(operator)) {
		check.errors.push(`Invalid operator '${operator}' for field '${field}' (type: ${spec.type})`)
		return condition
	}
	if (Array.isArray(condition.value) && condition.value.length > check.limits.maxInValues) {
		check.errors.push(
			`in/nin list too large for '${field}': ${condition.value.length} (max ${check.limits.maxInValues})`,
		)
	}
	refuseLongPattern(condition, check)
	const typed = typedValue(spec, condition)
	if ("error" in typed) {
		check.errors.push(`Invalid value for '${field}': ${typed.error}`)
		return condition
	}
	return { ...condition, value: typed.value }
}

/** The group with every condition checked and typed, and how many conditions and levels it holds */
type Shape = { conditions: number; depth: number; group: FilterGroup; values: number }

function checkGroup(group: FilterGroup, check: Check, depth: number): Shape {
	const subgroups = group.subgroups.map((subgroup) => checkGroup(subgroup, check, depth + 1))
	/* counted on the typed conditions: is.true binds its boolean, is.null nothing */
	const conditions = group.conditions.map((condition) => checkCondition(condition, check))
	const values = conditions.reduce((total, condition) => total + boundBy(condition), 0)
	return {
		conditions: subgroups.reduce((total, sub) => total + sub.conditions, group.conditions.length),
		depth: Math.max(depth, ...subgroups.map((sub) => sub.depth)),
		values: subgroups.reduce((total, sub) => total + sub.values, values),
		group: {
			conditions,
			logic: group.logic,
			subgroups: subgroups.map((sub) => sub.group),
		},
	}
}

/**
 * Parse `filterString` and check it against `allowedFields`: known fields, operators their type
 * or spec allows, values of their type, within `limits`. Null when there is no filter. A spec
 * that lists an operator its type cannot take, or a format on no date, throws a TypeError.
 */
function validateFilter(
	filterString: string | null | undefined,
	allowedFields: Record<string, FilterField>,
	limits?: LimitsGiven<FilterLimits> | undefined,
): FilterValidationResult | null {
	const fields = checkedFields(allowedFields)
	const caps = limitsOver("validateFilter", FILTER_LIMITS, limits)
	if (!filterString || filterString.trim() === "") return null
	const ast = parseFilter(filterString)
	if (!ast) return { errors: ["Invalid filter syntax"], valid: false }

	const check: Check = { errors: [], fields, limits: caps }
	const shape = checkGroup(ast.root, check, 0)
	if (shape.conditions > check.limits.maxConditions) {
		check.errors.push(`Too many filter conditions: ${shape.conditions} (max ${check.limits.maxConditions})`)
	}
	if (shape.values > check.limits.maxValues) {
		check.errors.push(`Filter binds too many values: ${shape.values} (max ${check.limits.maxValues})`)
	}
	if (shape.depth > check.limits.maxDepth) {
		check.errors.push(`Filter nesting too deep: ${shape.depth} (max ${check.limits.maxDepth})`)
	}
	return check.errors.length > 0 ? { errors: check.errors, valid: false } : { ast: { root: shape.group }, valid: true }
}

export {
	FILTER_LIMITS,
	limitsOver,
	OPERATORS_BY_TYPE,
	validateFilter,
	type FilterField,
	type FilterFieldSpec,
	type FilterLimits,
	type LimitsGiven,
	type FilterValidationResult,
}
