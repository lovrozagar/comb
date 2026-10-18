import { describe, expect, it } from "vitest"
import { FILTER_OPERATORS, parseFilter } from "./filter-parse.ts"

const value = (input: string) => parseFilter(input)?.root.conditions[0]?.value

/** A well-formed single-condition filter for `op`, with the value shape that operator takes. */
function sampleFor(op: string): string {
	if (op === "in" || op === "nin") return `f.${op}.(a,b)`
	if (op === "is") return `f.${op}.null`
	return `f.${op}.val`
}

describe("parseFilter", () => {
	it("returns null for empty input", () => {
		expect(parseFilter(null)).toBeNull()
		expect(parseFilter(undefined)).toBeNull()
		expect(parseFilter("")).toBeNull()
		expect(parseFilter("  ")).toBeNull()
	})

	it("parses simple eq condition", () => {
		const ast = parseFilter("status.eq.active")
		expect(ast).toBeTruthy()
		expect(ast?.root.conditions).toHaveLength(1)
		expect(ast?.root.conditions[0]).toEqual({
			field: "status",
			operator: "eq",
			value: "active",
		})
	})

	it("parses multiple AND conditions", () => {
		const ast = parseFilter("status.eq.active,name.like.%test%")
		expect(ast?.root.conditions).toHaveLength(2)
		expect(ast?.root.logic).toBe("and")
	})

	it("parses OR groups", () => {
		const ast = parseFilter("or(status.eq.active,status.eq.pending)")
		expect(ast?.root.subgroups).toHaveLength(1)
		expect(ast?.root.subgroups[0]?.logic).toBe("or")
		expect(ast?.root.subgroups[0]?.conditions).toHaveLength(2)
	})

	it("parses nested AND groups", () => {
		const ast = parseFilter("and(a.eq.1,b.eq.2)")
		expect(ast?.root.subgroups).toHaveLength(1)
		expect(ast?.root.subgroups[0]?.logic).toBe("and")
	})
})

describe("parseFilter — operators and fields", () => {
	it("parses in operator with list values", () => {
		const ast = parseFilter("status.in.(active,pending,draft)")
		expect(ast?.root.conditions[0]?.operator).toBe("in")
		expect(ast?.root.conditions[0]?.value).toEqual(["active", "pending", "draft"])
	})

	it("parses nin operator", () => {
		const ast = parseFilter("type.nin.(archived,deleted)")
		expect(ast?.root.conditions[0]?.operator).toBe("nin")
		expect(ast?.root.conditions[0]?.value).toEqual(["archived", "deleted"])
	})

	it("parses is.null", () => {
		const ast = parseFilter("deletedAt.is.null")
		expect(ast?.root.conditions[0]?.value).toBeNull()
	})

	it("parses is.notnull", () => {
		const ast = parseFilter("deletedAt.is.notnull")
		expect(ast?.root.conditions[0]?.value).toBe("notnull")
	})

	it("parses relation field (dot path)", () => {
		const ast = parseFilter("tags.name.eq.important")
		expect(ast?.root.conditions[0]?.field).toBe("tags.name")
	})

	it("parses computed field (@ prefix)", () => {
		const ast = parseFilter("@totalPrice.gte.100")
		expect(ast?.root.conditions[0]?.field).toBe("@totalPrice")
	})

	it("keeps * wildcards in the AST for like", () => {
		const ast = parseFilter("title.like.*summer*")
		expect(ast?.root.conditions[0]?.value).toBe("*summer*")
	})

	it("handles all operators", () => {
		for (const op of FILTER_OPERATORS) {
			expect(parseFilter(sampleFor(op))?.root.conditions[0]?.operator).toBe(op)
		}
	})
})

describe("parseFilter — malformed input", () => {
	const malformed = [
		["a field with no operator", "status"],
		["an operator with no value", "status.eq"],
		["an unknown operator", "status.frobnicate.x"],
		["a leading dot", ".eq.x"],
		["a bare dot", "."],
		["an empty group", "or()"],
		["an unclosed group", "or(status.eq.a"],
		["only a comma", ","],
		["only whitespace inside a group", "or(   )"],
	]

	for (const [label, input] of malformed) {
		it(`does not throw on ${label}`, () => {
			expect(() => parseFilter(input)).not.toThrow()
		})
	}

	it("returns null rather than a partial AST when nothing parses", () => {
		expect(parseFilter("status")).toBeNull()
		expect(parseFilter(".")).toBeNull()
	})

	it("returns null for empty and whitespace-only input", () => {
		expect(parseFilter("")).toBeNull()
		expect(parseFilter("   ")).toBeNull()
		expect(parseFilter(null)).toBeNull()
		expect(parseFilter(undefined)).toBeNull()
	})

	it("tolerates whitespace around terms", () => {
		const ast = parseFilter(" status.eq.draft , views.gt.5 ")
		expect(ast?.root.conditions.length).toBeGreaterThan(0)
	})

	it("keeps an unrecognised is value as a literal rather than guessing", () => {
		const ast = parseFilter("status.is.maybe")
		expect(ast?.root.conditions[0]?.value).toBe("maybe")
	})

	it("parses is.null and is.notnull into their sentinel values", () => {
		expect(parseFilter("status.is.null")?.root.conditions[0]?.value).toBeNull()
		expect(parseFilter("status.is.notnull")?.root.conditions[0]?.value).toBe("notnull")
	})

	it("stops a list at the closing paren", () => {
		const ast = parseFilter("status.in.(a,b)")
		expect(ast?.root.conditions[0]?.value).toEqual(["a", "b"])
	})

	it("handles a list that is never closed", () => {
		expect(() => parseFilter("status.in.(a,b")).not.toThrow()
	})
})

describe("parseFilter — termination", () => {
	/* A filter string arrives straight off the query string. Before this was
	   fixed, parseCondition rewound the cursor on failure and parseGroup looped
	   without progress, so `?filter=status` hung the request forever. */
	const hostile = [
		"status",
		"status.eq",
		".eq.x",
		".",
		"..",
		"status.frobnicate.x",
		"a.b.c.d.e",
		"or(status)",
		"and(.)",
		"status,,,",
		"(((",
		")))",
		"or(or(or(",
		"a".repeat(2000),
		`${"or(".repeat(50)}status.eq.x`,
	]

	for (const input of hostile) {
		it(`terminates on ${JSON.stringify(input.slice(0, 28))}`, () => {
			const started = Date.now()
			expect(() => parseFilter(input)).not.toThrow()
			expect(Date.now() - started).toBeLessThan(1000)
		})
	}

	it("rejects a filter it could not fully parse rather than ignoring it", () => {
		/* Returning an empty AST would widen the query to the whole table. */
		expect(parseFilter("status")).toBeNull()
		expect(parseFilter("status.eq.draft,garbage")).toBeNull()
	})

	it("still parses a well-formed filter unchanged", () => {
		expect(parseFilter("status.eq.draft")?.root.conditions).toHaveLength(1)
		expect(parseFilter("or(a.eq.1,b.eq.2)")?.root.subgroups).toHaveLength(1)
	})
})

describe("parseFilter — structural strictness", () => {
	it("rejects an or( group that is never closed", () => {
		expect(parseFilter("or(name.eq.a")).toBeNull()
		expect(parseFilter("and(name.eq.a,or(b.eq.c)")).toBeNull()
	})

	it("rejects a stray closing paren", () => {
		expect(parseFilter("name.eq.a)")).toBeNull()
		expect(parseFilter("or(name.eq.a))")).toBeNull()
	})

	it("rejects an in list that is never closed", () => {
		expect(parseFilter("name.in.(a,b")).toBeNull()
	})

	it("still accepts well-formed nesting", () => {
		expect(parseFilter("or(a.eq.1,and(b.eq.2,c.eq.3))")).not.toBeNull()
	})
})

describe("parseFilter — quoted values and whitespace (Q-L1, Q-L2)", () => {
	it("reads a quoted value that holds commas, parentheses and dots", () => {
		expect(value('title.eq."a,b"')).toBe("a,b")
		expect(value('title.eq."Hello (world)"')).toBe("Hello (world)")
		expect(value('title.eq."v1.2.eq.3"')).toBe("v1.2.eq.3")
	})

	it('unescapes \\" and \\\\ inside quotes', () => {
		expect(value('title.eq."say \\"hi\\""')).toBe('say "hi"')
		expect(value('title.eq."back\\\\slash"')).toBe("back\\slash")
	})

	it("reads quoted list members without their quotes", () => {
		expect(value('title.in.("Intro","intro two")')).toEqual(["Intro", "intro two"])
		expect(value('title.in.("a,b",c)')).toEqual(["a,b", "c"])
	})

	it("trims the whitespace around a bare value", () => {
		expect(parseFilter("title.eq.Intro ,minute_read.gt.0")?.root.conditions.map((c) => c.value)).toEqual(["Intro", "0"])
		expect(value("title.in.( a , b )")).toEqual(["a", "b"])
	})

	it("reads every operator, the longest that fits first", () => {
		for (const operator of FILTER_OPERATORS) {
			expect(parseFilter(`f.${operator}.x`)?.root.conditions[0]?.operator).toBe(operator)
		}
	})

	it("parses contains, for callers that validate and run it themselves (canary: anyrow row filters)", () => {
		expect(FILTER_OPERATORS).toContain("contains")
		expect(parseFilter("tags.contains.red")?.root.conditions[0]).toEqual({
			field: "tags",
			operator: "contains",
			value: "red",
		})
	})

	it("keeps an empty quoted list member and drops an empty bare one", () => {
		expect(value('title.in.("",a,)')).toEqual(["", "a"])
		expect(value("title.in.(a,,b)")).toEqual(["a", "b"])
	})

	it("refuses an unterminated quote", () => {
		expect(parseFilter('title.eq."open')).toBeNull()
	})
})
