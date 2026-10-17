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
}

const FILTER_LIMITS: FilterLimits = { maxConditions: 20, maxDepth: 3, maxInValues: 100 }

/** A value typed as its field declares, or why it cannot be */
type Typed = { value: unknown } | { error: string }

const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const EPOCH_MS = /^-?\d+$/

/** One scalar of a `type` field, as the request wrote it */
function typedScalar(type: FieldType, raw: string): Typed {
	switch (type) {
		case "number":
			return NUMBER.test(raw) ? { value: Number(raw) } : { error: `expects a number, got '${raw}'` }
		case "date":
			return EPOCH_MS.test(raw) ? { value: Number(raw) } : { error: `expects epoch milliseconds, got '${raw}'` }
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
function checkGroup(
	group: FilterGroup,
	check: Check,
	depth: number,
): { group: FilterGroup; conditions: number; depth: number } {
	const subgroups = group.subgroups.map((subgroup) => checkGroup(subgroup, check, depth + 1))
	return {
		conditions: subgroups.reduce((total, sub) => total + sub.conditions, group.conditions.length),
		depth: Math.max(depth, ...subgroups.map((sub) => sub.depth)),
		group: {
			conditions: group.conditions.map((condition) => checkCondition(condition, check)),
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
	if (shape.depth > check.limits.maxDepth) {
		check.errors.push(`Filter nesting too deep: ${shape.depth} (max ${check.limits.maxDepth})`)
	}
	return check.errors.length > 0 ? { errors: check.errors, valid: false } : { ast: { root: shape.group }, valid: true }
}

export { FILTER_LIMITS, OPERATORS_BY_TYPE, validateFilter, type FilterLimits, type FilterValidationResult }
