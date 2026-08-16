import { describe, expect, it } from "vitest"
import {
	FILTER_OPERATORS,
	OPERATORS_BY_TYPE,
	parseFilter,
	parseOrder,
	validateFilter,
} from "../../../src/query/filter.ts"

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

	it("converts * wildcards to % for like", () => {
		const ast = parseFilter("title.like.*summer*")
		expect(ast?.root.conditions[0]?.value).toBe("%summer%")
	})

	it("handles all operators", () => {
		for (const op of FILTER_OPERATORS) {
			if (op === "in" || op === "nin") {
				const ast = parseFilter(`f.${op}.(a,b)`)
				expect(ast?.root.conditions[0]?.operator).toBe(op)
			} else if (op === "is") {
				const ast = parseFilter(`f.${op}.null`)
				expect(ast?.root.conditions[0]?.operator).toBe(op)
			} else {
				const ast = parseFilter(`f.${op}.val`)
				expect(ast?.root.conditions[0]?.operator).toBe(op)
			}
		}
	})
})

describe("validateFilter", () => {
	it("returns null for empty filter", () => {
		expect(validateFilter("", {})).toBeNull()
		expect(validateFilter(null, {})).toBeNull()
	})

	it("validates known fields", () => {
		const result = validateFilter("status.eq.active", { status: "enum" })
		expect(result?.valid).toBe(true)
	})

	it("rejects unknown fields", () => {
		const result = validateFilter("unknown.eq.x", { status: "enum" })
		expect(result?.valid).toBe(false)
		if (result && !result.valid) {
			expect(result.errors[0]).toContain("Unknown filter field")
		}
	})

	it("rejects invalid operators for field type", () => {
		const result = validateFilter("active.like.%test%", { active: "boolean" })
		expect(result?.valid).toBe(false)
	})

	it("allows valid operators for each type", () => {
		for (const [type, ops] of Object.entries(OPERATORS_BY_TYPE)) {
			for (const op of ops) {
				let filterStr: string
				if (op === "in" || op === "nin") {
					filterStr = `f.${op}.(a,b)`
				} else if (op === "is") {
					filterStr = "f.is.null"
				} else {
					filterStr = `f.${op}.val`
				}
				const result = validateFilter(filterStr, { f: type as "string" })
				expect(result?.valid).toBe(true)
			}
		}
	})

	it("validates subgroups", () => {
		const result = validateFilter("or(bad.eq.x)", { status: "enum" })
		expect(result?.valid).toBe(false)
	})
})

describe("parseOrder", () => {
	/* empty-input parity */
	it("returns empty for null", () => {
		expect(parseOrder(null)).toEqual([])
	})

	it("returns empty for undefined", () => {
		expect(parseOrder(undefined)).toEqual([])
	})

	it("returns empty for empty string", () => {
		expect(parseOrder("")).toEqual([])
	})

	it("returns empty for whitespace-only", () => {
		expect(parseOrder("   ")).toEqual([])
	})

	/* single-field direction */
	it("parses bare field as asc default", () => {
		expect(parseOrder("name")).toEqual([{ direction: "asc", field: "name" }])
	})

	it("parses field.asc explicitly", () => {
		expect(parseOrder("name.asc")).toEqual([{ direction: "asc", field: "name" }])
	})

	it("parses field.desc", () => {
		expect(parseOrder("createdAt.desc")).toEqual([{ direction: "desc", field: "createdAt" }])
	})

	/* null ordering */
	it("parses field.nullsfirst (asc default)", () => {
		expect(parseOrder("name.nullsfirst")).toEqual([{ direction: "asc", field: "name", nulls: "first" }])
	})

	it("parses field.nullslast (asc default)", () => {
		expect(parseOrder("name.nullslast")).toEqual([{ direction: "asc", field: "name", nulls: "last" }])
	})

	it("parses field.asc.nullsfirst", () => {
		expect(parseOrder("name.asc.nullsfirst")).toEqual([{ direction: "asc", field: "name", nulls: "first" }])
	})

	it("parses field.asc.nullslast", () => {
		expect(parseOrder("name.asc.nullslast")).toEqual([{ direction: "asc", field: "name", nulls: "last" }])
	})

	it("parses field.desc.nullsfirst", () => {
		expect(parseOrder("createdAt.desc.nullsfirst")).toEqual([{ direction: "desc", field: "createdAt", nulls: "first" }])
	})

	it("parses field.desc.nullslast", () => {
		expect(parseOrder("createdAt.desc.nullslast")).toEqual([{ direction: "desc", field: "createdAt", nulls: "last" }])
	})

	/* multi-field */
	it("parses comma-separated fields", () => {
		expect(parseOrder("col1.desc,col2.asc")).toEqual([
			{ direction: "desc", field: "col1" },
			{ direction: "asc", field: "col2" },
		])
	})

	it("parses mixed with nulls", () => {
		expect(parseOrder("col1.desc,col2.asc.nullsfirst")).toEqual([
			{ direction: "desc", field: "col1" },
			{ direction: "asc", field: "col2", nulls: "first" },
		])
	})

	it("skips empty comma parts", () => {
		const result = parseOrder(",name.asc,,")
		expect(result).toHaveLength(1)
		expect(result[0]?.field).toBe("name")
	})

	it("trims whitespace around parts", () => {
		const result = parseOrder(" col1.desc , col2.asc ")
		expect(result).toHaveLength(2)
		expect(result[0]?.field).toBe("col1")
		expect(result[1]?.field).toBe("col2")
	})

	/* computed fields (anyrow @ prefix) */
	it("preserves @ prefix on computed fields", () => {
		expect(parseOrder("@totalPrice.desc")).toEqual([{ direction: "desc", field: "@totalPrice" }])
	})

	it("computed field with nulls suffix", () => {
		expect(parseOrder("@score.desc.nullslast")).toEqual([{ direction: "desc", field: "@score", nulls: "last" }])
	})

	/* edge cases / malformed input */
	it("rejects JSON:API '-' prefix (no longer supported)", () => {
		/* '-' is not a known suffix token — parser emits literal field name */
		expect(parseOrder("-name")).toEqual([{ direction: "asc", field: "-name" }])
	})

	it("rejects JSON:API '+' prefix (no longer supported)", () => {
		/* '+' is not a known suffix token — parser emits literal field name */
		expect(parseOrder("+name")).toEqual([{ direction: "asc", field: "+name" }])
	})

	it("ignores unknown direction token", () => {
		/* 'foo' not a known suffix — stays joined as literal field name */
		expect(parseOrder("name.foo")).toEqual([{ direction: "asc", field: "name.foo" }])
	})

	/* field name integrity */
	it("handles dotted relation field path", () => {
		/* right-to-left peel: 'asc' consumed, remainder 'author.name' is the field */
		expect(parseOrder("author.name.asc")).toEqual([{ direction: "asc", field: "author.name" }])
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

describe("validateFilter — diagnostics", () => {
	it("reports invalid syntax rather than throwing", () => {
		const result = validateFilter("status", { status: "enum" })
		expect(result?.valid).toBe(false)
		if (result && !result.valid) expect(result.errors[0]).toContain("Invalid filter syntax")
	})

	it("reports a field absent from the allowed set", () => {
		const result = validateFilter("secret.eq.x", { status: "enum" })
		expect(result?.valid).toBe(false)
		if (result && !result.valid) expect(result.errors.join(" ")).toContain("Unknown filter field")
	})

	it("reports an operator the field's type does not support", () => {
		const result = validateFilter("active.like.x", { active: "boolean" })
		expect(result?.valid).toBe(false)
		if (result && !result.valid) expect(result.errors.join(" ")).toContain("Invalid operator")
	})

	it("returns null for an absent filter rather than an empty result", () => {
		expect(validateFilter(null, { status: "enum" })).toBeNull()
		expect(validateFilter("   ", { status: "enum" })).toBeNull()
	})
})

describe("parseOrder — malformed input", () => {
	it("returns nothing for empty or absent input", () => {
		expect(parseOrder("")).toEqual([])
		expect(parseOrder(null)).toEqual([])
		expect(parseOrder(undefined)).toEqual([])
	})

	it("skips empty segments between commas", () => {
		expect(parseOrder("created_at.desc,,title.asc")).toHaveLength(2)
	})

	it("skips a segment that names no field", () => {
		expect(parseOrder(".desc")).toEqual([])
		/* a bare direction is consumed as the direction, leaving no field behind */
		expect(parseOrder("asc")).toEqual([])
	})

	it("defaults to ascending when no direction is given", () => {
		expect(parseOrder("title")).toEqual([{ direction: "asc", field: "title" }])
	})

	it("reads null placement off the end of the segment", () => {
		expect(parseOrder("title.desc.nullslast")).toEqual([{ direction: "desc", field: "title", nulls: "last" }])
		expect(parseOrder("title.nullsfirst")).toEqual([{ direction: "asc", field: "title", nulls: "first" }])
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
