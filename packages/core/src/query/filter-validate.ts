/**
 * Validating a filter against the fields an endpoint declares. A valid filter comes back with
 * every value typed as its field declares, so SQL generation binds numbers as numbers and
 * booleans as booleans, and computed resolvers receive the declared type.
 */
import { parseFilter } from "./filter-parse.ts"
import type { FieldType, FilterAST, FilterCondition, FilterGroup, FilterOperator } from "./types.ts"

const OPERATORS_BY_TYPE: Record<FieldType, readonly FilterOperator[]> = {
	boolean: ["eq", "ne", "neq", "is"],
	date: ["eq", "ne", "neq", "gt", "gte", "lt", "lte", "is"],
	enum: ["eq", "ne", "neq", "in", "nin", "is"],
	number: ["eq", "ne", "neq", "gt", "gte", "lt", "lte", "in", "nin", "is"],
	string: ["eq", "ne", "neq", "like", "ilike", "in", "nin", "is"],
} as const

type FilterValidationResult = { ast: FilterAST; valid: true } | { errors: string[]; valid: false }

/** Bounds on one filter expression. Each condition is a predicate SQLite evaluates per row. */
type FilterLimits = {
	maxConditions: number
	/** Nested or()/and() groups below the top level */
	maxDepth: number
	maxInValues: number
	/** Values the whole filter binds, every in/nin member counted: D1 binds at most 100 per statement */
	maxValues: number
}

const FILTER_LIMITS: FilterLimits = { maxConditions: 20, maxDepth: 3, maxInValues: 50, maxValues: 60 }

/** The parameters one condition binds */
const boundBy = ({ operator, value }: FilterCondition) =>
	Array.isArray(value) ? value.length : operator === "is" && typeof value !== "boolean" ? 0 : 1

/** A value typed as its field declares, or why it cannot be */
type Typed = { value: unknown } | { error: string }

const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const INTEGER = /^-?\d+$/
/* the widest instant a JS Date holds, in epoch milliseconds either way */
const MAX_EPOCH_MS = 8.64e15

/**
 * A number field's value: finite (1e999 reads as Infinity, which no column holds), and within
 * ±(2^53 − 1), past which a double binds a neighbouring value. The value is read, not its
 * spelling: `9007199254740993.0` and `9.007199254740993e15` are the same unsafe integer.
 */
function typedNumber(raw: string): Typed {
	const value = Number(raw)
	if (!NUMBER.test(raw) || !Number.isFinite(value)) return { error: `expects a number, got '${raw}'` }
	if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
		return { error: `expects a number within ±${Number.MAX_SAFE_INTEGER}, got '${raw}'` }
	}
	return { value }
}

/** A date field's value: epoch milliseconds a JS Date holds */
function typedDate(raw: string): Typed {
	if (!INTEGER.test(raw)) return { error: `expects epoch milliseconds, got '${raw}'` }
	if (Math.abs(Number(raw)) > MAX_EPOCH_MS)
		return { error: `expects epoch milliseconds within ±${MAX_EPOCH_MS}, got '${raw}'` }
	return { value: Number(raw) }
}

/** One scalar of a `type` field, as the request wrote it */
function typedScalar(type: FieldType, raw: string): Typed {
	switch (type) {
		case "number":
			return typedNumber(raw)
		case "date":
			return typedDate(raw)
		case "boolean":
			return raw === "true" || raw === "false"
				? { value: raw === "true" }
				: { error: `expects true or false, got '${raw}'` }
		default:
			return { value: raw }
	}
}

/** `is` takes null and notnull on every field, true and false on a boolean one */
function typedIs(type: FieldType, raw: unknown): Typed {
	if (raw === null) return { value: null }
	const keyword = String(raw).toLowerCase()
	if (keyword === "notnull") return { value: "notnull" }
	if (type === "boolean" && (keyword === "true" || keyword === "false")) return { value: keyword === "true" }
	return { error: `is takes ${type === "boolean" ? "null, notnull, true or false" : "null or notnull"}, got '${raw}'` }
}

function typedValue(type: FieldType, { operator, value }: FilterCondition): Typed {
	if (operator === "is") return typedIs(type, value)
	const lists = operator === "in" || operator === "nin"
	if (lists && !Array.isArray(value)) return { error: "in and nin take a list, as in.(a,b)" }
	if (!Array.isArray(value)) return typedScalar(type, String(value))
	const items = value.map((item) => typedScalar(type, String(item)))
	const failed = items.find((item) => "error" in item)
	return failed ?? { value: items.map((item) => (item as { value: unknown }).value) }
}

type Check = { errors: string[]; fields: Record<string, FieldType>; limits: FilterLimits }

function checkCondition(condition: FilterCondition, check: Check): FilterCondition {
	const { field, operator } = condition
	if (!Object.hasOwn(check.fields, field)) {
		check.errors.push(`Unknown filter field: ${field}`)
		return condition
	}
	const type = check.fields[field] as FieldType
	if (!OPERATORS_BY_TYPE[type].includes(operator)) {
		check.errors.push(`Invalid operator '${operator}' for field '${field}' (type: ${type})`)
		return condition
	}
	if (Array.isArray(condition.value) && condition.value.length > check.limits.maxInValues) {
		check.errors.push(
			`in/nin list too large for '${field}': ${condition.value.length} (max ${check.limits.maxInValues})`,
		)
	}
	const typed = typedValue(type, condition)
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
 * allows, values of their type, within `limits`. Null when there is no filter.
 */
function validateFilter(
	filterString: string | null | undefined,
	allowedFields: Record<string, FieldType>,
	limits?: Partial<FilterLimits>,
): FilterValidationResult | null {
	if (!filterString || filterString.trim() === "") return null
	const ast = parseFilter(filterString)
	if (!ast) return { errors: ["Invalid filter syntax"], valid: false }

	const check: Check = { errors: [], fields: allowedFields, limits: { ...FILTER_LIMITS, ...limits } }
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

export { FILTER_LIMITS, OPERATORS_BY_TYPE, validateFilter, type FilterLimits, type FilterValidationResult }
