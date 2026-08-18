/**
 * PostgREST-style filter parser + validation + sort parser.
 * DB-agnostic — no SQL generation, only AST production.
 */
import type {
	FieldType,
	FilterAST,
	FilterCondition,
	FilterGroup,
	FilterOperator,
	SortDirection,
	SortField,
} from "./types.ts"

const FILTER_OPERATORS: readonly FilterOperator[] = [
	"eq",
	"ne",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"nin",
	"like",
	"ilike",
	"is",
	"contains",
] as const

const OPERATORS_BY_TYPE: Record<FieldType, readonly FilterOperator[]> = {
	boolean: ["eq", "ne", "neq", "is"],
	date: ["eq", "ne", "neq", "gt", "gte", "lt", "lte", "is"],
	enum: ["eq", "ne", "neq", "in", "nin", "is"],
	number: ["eq", "ne", "neq", "gt", "gte", "lt", "lte", "in", "nin", "is"],
	string: ["eq", "ne", "neq", "like", "ilike", "in", "nin", "is"],
} as const

/**
 * Parse PostgREST-style filter string into AST
 *
 * Grammar:
 * - field.op.value — single condition
 * - , — AND (at top level and inside groups)
 * - or(...) — OR grouping
 * - and(...) — nested AND grouping
 * - in.(val1,val2) — list values
 * - @ prefix — computed fields
 */
class FilterParser {
	private input: string
	private pos: number

	constructor(input: string) {
		this.input = input
		this.pos = 0
	}

	private malformed = false

	/** True when any term could not be parsed — the input is not trustworthy. */
	get hadError(): boolean {
		return this.malformed
	}

	parse(): FilterAST {
		const root = this.parseGroup("and")
		return { root }
	}

	/**
	 * Advance to the next separator so a malformed term cannot stall the parser.
	 * Guarantees forward progress for the parseGroup loop.
	 */
	private skipToSeparator(): void {
		while (this.pos < this.input.length) {
			const char = this.peek()
			if (char === "," || char === ")") return
			this.pos++
		}
	}

	private parseGroup(logic: "and" | "or"): FilterGroup {
		const conditions: FilterCondition[] = []
		const subgroups: FilterGroup[] = []

		while (this.pos < this.input.length) {
			this.skipWhitespace()

			if (this.pos >= this.input.length) break

			if (this.peek() === ")") {
				break
			}

			if (this.matchKeyword("or(")) {
				this.pos += 3
				subgroups.push(this.parseGroup("or"))
				this.expect(")")
			} else if (this.matchKeyword("and(")) {
				this.pos += 4
				subgroups.push(this.parseGroup("and"))
				this.expect(")")
			} else {
				const condition = this.parseCondition()
				if (condition) {
					conditions.push(condition)
				} else {
					/* parseCondition rewinds to where it started when it fails, so the
					   loop would make no progress and spin forever on input like
					   "status" or ".eq.x". Skip the malformed term instead, and record
					   that the input was not fully understood. */
					this.malformed = true
					this.skipToSeparator()
				}
			}

			this.skipWhitespace()

			if (this.peek() === ",") {
				this.pos++
			} else if (this.peek() === ")") {
				break
			}
		}

		return { conditions, logic, subgroups }
	}

	private parseCondition(): FilterCondition | null {
		const startPos = this.pos

		const fieldParts: string[] = []
		let currentPart = ""

		while (this.pos < this.input.length) {
			const char = this.peek()

			if (char === ".") {
				const remaining = this.input.slice(this.pos + 1)
				const operatorMatch = this.matchOperatorAt(remaining)

				if (operatorMatch) {
					if (currentPart) {
						fieldParts.push(currentPart)
						currentPart = ""
					}
					break
				}

				if (currentPart) {
					fieldParts.push(currentPart)
					currentPart = ""
				}
				this.pos++
			} else if (char === "," || char === ")" || char === "(") {
				break
			} else {
				currentPart += char
				this.pos++
			}
		}

		if (fieldParts.length === 0 && !currentPart) {
			this.pos = startPos
			return null
		}

		if (currentPart) {
			fieldParts.push(currentPart)
		}

		if (this.peek() !== ".") {
			this.pos = startPos
			return null
		}
		this.pos++

		const operator = this.parseOperator()
		if (!operator) {
			this.pos = startPos
			return null
		}

		if (this.peek() !== ".") {
			this.pos = startPos
			return null
		}
		this.pos++

		const value = this.parseValue(operator)
		const field = fieldParts.join(".")

		return { field, operator, value }
	}

	private parseOperator(): FilterOperator | null {
		for (const op of FILTER_OPERATORS) {
			if (this.input.slice(this.pos, this.pos + op.length) === op) {
				const nextChar = this.input[this.pos + op.length]
				if (nextChar === ".") {
					this.pos += op.length
					return op
				}
			}
		}
		return null
	}

	private matchOperatorAt(str: string): FilterOperator | null {
		for (const op of FILTER_OPERATORS) {
			if (str.startsWith(`${op}.`)) {
				return op
			}
		}
		return null
	}

	private parseValue(operator: FilterOperator): unknown {
		/* Handle list values: in.(val1,val2,val3) */
		if ((operator === "in" || operator === "nin") && this.peek() === "(") {
			this.pos++
			const values: string[] = []
			let currentValue = ""

			while (this.pos < this.input.length && this.peek() !== ")") {
				const char = this.peek()
				if (char === ",") {
					if (currentValue) {
						values.push(this.parseScalarValue(currentValue))
						currentValue = ""
					}
					this.pos++
				} else {
					currentValue += char
					this.pos++
				}
			}

			if (currentValue) {
				values.push(this.parseScalarValue(currentValue))
			}

			if (this.peek() === ")") {
				this.pos++
			}

			return values
		}

		/* Handle null check: is.null or is.notnull */
		if (operator === "is") {
			let value = ""
			while (this.pos < this.input.length) {
				const char = this.peek()
				if (char === "," || char === ")") break
				value += char
				this.pos++
			}

			if (value === "null") return null
			if (value === "notnull") return "notnull"
			return value
		}

		/* Parse regular value until comma or end */
		let value = ""
		while (this.pos < this.input.length) {
			const char = this.peek()
			if (char === "," || char === ")") break
			value += char
			this.pos++
		}

		return this.parseScalarValue(value)
	}

	private parseScalarValue(value: string): string {
		/* Keep `*` — SQL like/ilike expand it after escaping literal `%` `_`. */
		return value
	}

	private matchKeyword(keyword: string): boolean {
		return this.input.slice(this.pos, this.pos + keyword.length).toLowerCase() === keyword
	}

	private peek(): string {
		return this.input[this.pos] || ""
	}

	private expect(char: string): void {
		if (this.peek() === char) {
			this.pos++
		}
	}

	private skipWhitespace(): void {
		while (this.pos < this.input.length && /\s/.test(this.peek())) {
			this.pos++
		}
	}
}

function parseFilter(input: string | null | undefined): FilterAST | null {
	if (!input || input.trim() === "") {
		return null
	}

	try {
		const parser = new FilterParser(input.trim())
		const ast = parser.parse()
		/* A filter the parser could not fully understand must be rejected, not
		   quietly reduced to "no filter" — that would widen the result set to
		   the whole table on a typo. */
		if (parser.hadError) return null
		return ast
	} catch {
		return null
	}
}

type FilterValidationResult = { ast: FilterAST; valid: true } | { errors: string[]; valid: false }

function validateFilter(
	filterString: string | null | undefined,
	allowedFields: Record<string, FieldType>,
): FilterValidationResult | null {
	if (!filterString || filterString.trim() === "") {
		return null
	}

	const ast = parseFilter(filterString)
	if (!ast) {
		return { errors: ["Invalid filter syntax"], valid: false }
	}

	const errors: string[] = []
	const allowedSet = new Set(Object.keys(allowedFields))

	validateGroup(ast.root, allowedSet, allowedFields, errors)

	if (errors.length > 0) {
		return { errors, valid: false }
	}

	return { ast, valid: true }
}

function validateGroup(
	group: FilterGroup,
	allowedFields: Set<string>,
	fieldTypes: Record<string, FieldType>,
	errors: string[],
): void {
	for (const condition of group.conditions) {
		validateCondition(condition, allowedFields, fieldTypes, errors)
	}

	for (const subgroup of group.subgroups) {
		validateGroup(subgroup, allowedFields, fieldTypes, errors)
	}
}

function validateCondition(
	condition: FilterCondition,
	allowedFields: Set<string>,
	fieldTypes: Record<string, FieldType>,
	errors: string[],
): void {
	const { field, operator } = condition

	if (!allowedFields.has(field)) {
		errors.push(`Unknown filter field: ${field}`)
		return
	}

	const fieldType = fieldTypes[field]
	if (!fieldType) {
		errors.push(`Unknown field type for: ${field}`)
		return
	}

	const allowedOperators = OPERATORS_BY_TYPE[fieldType]
	if (!allowedOperators || !allowedOperators.includes(operator)) {
		errors.push(`Invalid operator '${operator}' for field '${field}' (type: ${fieldType})`)
	}
}

function createFilterRefinement(allowedFields: Record<string, FieldType>) {
	return [
		(value: string | undefined) => {
			if (!value) return true
			const result = validateFilter(value, allowedFields)
			if (!result) return true
			return result.valid
		},
		(value: string | undefined) => {
			if (!value) return { message: "" }
			const result = validateFilter(value, allowedFields)
			if (!result || result.valid) return { message: "" }
			return { message: result.errors.join("; ") }
		},
	] as const
}

/**
 * Parse PostgREST-style `order` string into SortField array.
 *
 * Grammar:
 *   order  := entry ("," entry)*
 *   entry  := field ("." direction)? ("." nulls)?
 *   field  := any string not containing "." at the direction/nulls boundary
 *            (dotted relation paths OK: "author.name.asc")
 *   direction := "asc" | "desc"        (default "asc" when omitted)
 *   nulls     := "nullsfirst" | "nullslast"
 *
 * Examples:
 *   "name"                         → [{ field: "name", direction: "asc" }]
 *   "name.desc"                    → [{ field: "name", direction: "desc" }]
 *   "name.asc.nullslast"           → [{ field: "name", direction: "asc", nulls: "last" }]
 *   "col1.desc,col2.asc.nullsfirst"
 *     → [{field:"col1",direction:"desc"}, {field:"col2",direction:"asc",nulls:"first"}]
 *
 * Malformed entries are dropped silently — downstream schema validator
 * rejects unknown fields, which catches most mistakes.
 */
function parseOrder(input: string | null | undefined): SortField[] {
	if (!input || input.trim() === "") return []

	const fields: SortField[] = []
	const parts = input.split(",")

	for (const part of parts) {
		const trimmed = part.trim()
		if (!trimmed) continue

		const tokens = trimmed.split(".")
		if (tokens.length === 0) continue

		let nulls: "first" | "last" | undefined
		const last = tokens[tokens.length - 1]
		if (last === "nullsfirst") {
			nulls = "first"
			tokens.pop()
		} else if (last === "nullslast") {
			nulls = "last"
			tokens.pop()
		}

		let direction: SortDirection = "asc"
		const newLast = tokens[tokens.length - 1]
		if (newLast === "asc") {
			tokens.pop()
		} else if (newLast === "desc") {
			direction = "desc"
			tokens.pop()
		}

		const field = tokens.join(".")
		if (!field) continue

		const entry: SortField = { direction, field }
		if (nulls) entry.nulls = nulls
		fields.push(entry)
	}

	return fields
}

export {
	createFilterRefinement,
	FILTER_OPERATORS,
	OPERATORS_BY_TYPE,
	parseFilter,
	parseOrder,
	validateFilter,
	type FilterValidationResult,
}
