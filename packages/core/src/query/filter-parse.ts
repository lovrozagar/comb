/**
 * The PostgREST-style filter grammar: a filter string to its AST. Values stay as the request
 * wrote them; `validateFilter` checks them against the declared field types.
 *
 * - `field.op.value`: one condition; `,` joins conditions with AND
 * - `or(...)`, `and(...)`: groups, nestable
 * - `in.(a,b)`, `nin.(a,b)`: lists
 * - `"..."`: a quoted value may hold `,` `(` `)` and `.`; `\"` and `\\` escape inside it
 * - `@name`: a computed field
 */
import type { FilterAST, FilterCondition, FilterGroup, FilterOperator } from "./types.ts"

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

/** An operator and the `.` after it; longest first, so `neq.` is not read as `ne` then `q.` */
const OPERATOR_PATTERN = /^(contains|ilike|like|neq|gte|lte|nin|eq|ne|gt|lt|in|is)\./

class FilterParser {
	private pos = 0
	private malformed = false
	private readonly input: string

	constructor(input: string) {
		this.input = input
	}

	/** True when any term could not be parsed: the input is not trustworthy. */
	get hadError(): boolean {
		return this.malformed
	}

	parse(): FilterAST {
		const root = this.parseGroup("and")
		/* a stray ")" stops the top-level group early; anything left is unparsed */
		if (this.pos < this.input.length) this.malformed = true
		return { root }
	}

	private parseGroup(logic: "and" | "or"): FilterGroup {
		const group: FilterGroup = { conditions: [], logic, subgroups: [] }
		while (this.skipWhitespace() < this.input.length && this.peek() !== ")") {
			const nested = this.matchKeyword("or(") ? "or" : this.matchKeyword("and(") ? "and" : null
			if (nested) {
				this.pos += nested.length + 1
				group.subgroups.push(this.parseGroup(nested))
				this.expect(")")
			} else {
				this.parseTerm(group)
			}
			this.skipWhitespace()
			if (this.peek() !== ",") break
			this.pos++
		}
		return group
	}

	/** One condition into `group`; a term it cannot read is skipped and marks the input malformed */
	private parseTerm(group: FilterGroup): void {
		const condition = this.parseCondition()
		if (condition) {
			group.conditions.push(condition)
			return
		}
		this.malformed = true
		while (this.pos < this.input.length && this.peek() !== "," && this.peek() !== ")") this.pos++
	}

	private parseCondition(): FilterCondition | null {
		const head = this.readHead()
		return head && { ...head, value: this.readValueFor(head.operator) }
	}

	/** The field and operator: up to the first `.` that an operator and its own `.` follow */
	private readHead(): Omit<FilterCondition, "value"> | null {
		for (let at = this.pos; at < this.input.length; at++) {
			const char = this.input[at]
			if (char === "," || char === "(" || char === ")") return null
			const operator = char === "." ? OPERATOR_PATTERN.exec(this.input.slice(at + 1))?.[1] : undefined
			if (operator !== undefined) {
				const field = this.input.slice(this.pos, at).trim()
				this.pos = at + operator.length + 2
				return field === "" ? null : { field, operator: operator as FilterOperator }
			}
		}
		return null
	}

	private readValueFor(operator: FilterOperator): unknown {
		if ((operator === "in" || operator === "nin") && this.peek() === "(") return this.readList()
		const value = this.readValue()
		/* the value is a keyword here; validation decides which keywords the field accepts */
		return operator === "is" && value.toLowerCase() === "null" ? null : value
	}

	private readList(): string[] {
		this.pos++
		const values: string[] = []
		while (this.skipWhitespace() < this.input.length && this.peek() !== ")") {
			const quoted = this.peek() === '"'
			const value = this.readValue()
			if (quoted || value !== "") values.push(value)
			if (this.peek() === ",") this.pos++
		}
		this.expect(")")
		return values
	}

	/** A quoted value as written between its quotes, or a bare one up to `,` or `)`, trimmed */
	private readValue(): string {
		if (this.peek() === '"') return this.readQuoted()
		const start = this.pos
		while (this.pos < this.input.length && this.peek() !== "," && this.peek() !== ")") this.pos++
		return this.input.slice(start, this.pos).trim()
	}

	private readQuoted(): string {
		let value = ""
		for (this.pos++; this.pos < this.input.length; this.pos++) {
			const char = this.peek()
			if (char === '"') {
				this.pos++
				this.skipWhitespace()
				return value
			}
			if (char === "\\" && this.pos + 1 < this.input.length) this.pos++
			value += this.peek()
		}
		/* an unterminated quote */
		this.malformed = true
		return value
	}

	private matchKeyword(keyword: string): boolean {
		return this.input.slice(this.pos, this.pos + keyword.length).toLowerCase() === keyword
	}

	private peek(): string {
		return this.input[this.pos] ?? ""
	}

	/** A group that is never closed leaves the input unbalanced: reject it. */
	private expect(char: string): void {
		if (this.peek() === char) this.pos++
		else this.malformed = true
	}

	/** Step past whitespace; returns the new position */
	private skipWhitespace(): number {
		while (this.pos < this.input.length && /\s/.test(this.peek())) this.pos++
		return this.pos
	}
}

/**
 * The AST of a filter string, or null when there is none or any part of it cannot be read: a
 * filter the parser does not fully understand is refused, never reduced to "no filter", which
 * would widen the result to the whole table on a typo.
 */
function parseFilter(input: string | null | undefined): FilterAST | null {
	if (!input || input.trim() === "") return null
	const parser = new FilterParser(input.trim())
	const ast = parser.parse()
	return parser.hadError ? null : ast
}

export { FILTER_OPERATORS, parseFilter }
