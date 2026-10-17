import { describe, expect, it } from "vitest"
import { buildIdentifierValueMap, extractConstraints, extractLength } from "./constraint-text.ts"

describe("extractConstraints does not swallow a state machine", () => {
	it("returns an empty map for c.enum, even when a third argument is present", () => {
		expect(extractConstraints('c.enum("status", ["a", "b"], { terminal: ["b"], private: true })')).toEqual({})
	})
})

describe("extractLength", () => {
	it("extracts from max constraint", () => {
		expect(extractLength('c.text("name", { max: 100 })')).toBe(100)
	})

	it("extracts from positional parameter", () => {
		expect(extractLength('c.text("name", 50)')).toBe(50)
	})

	it("returns null when no length", () => {
		expect(extractLength('c.text("name")')).toBeNull()
	})
})

describe("extractConstraints", () => {
	it("extracts parameter-based constraints", () => {
		const result = extractConstraints('c.text("email", { min: 5, max: 254, email: true })')
		expect(result).toEqual({ email: true, max: 254, min: 5 })
	})

	it("returns empty for no constraints", () => {
		expect(extractConstraints('c.text("name")')).toEqual({})
	})

	it("handles boolean false values", () => {
		const result = extractConstraints('c.text("name", { trim: false })')
		expect(result).toEqual({ trim: false })
	})

	it("handles string values", () => {
		const result = extractConstraints('c.text("phone", { pattern: "/^\\\\+[0-9]+$/" })')
		expect(result.pattern).toBeDefined()
	})
})

describe("buildIdentifierValueMap", () => {
	it("skips a module that cannot be resolved rather than throwing", () => {
		const map = buildIdentifierValueMap(new Map([["patterns", "./definitely-not-here"]]), process.cwd())
		expect(map.size).toBe(0)
	})

	it("returns an empty map for no imports", () => {
		expect(buildIdentifierValueMap(new Map(), process.cwd()).size).toBe(0)
	})
})

describe("extractConstraints — value forms", () => {
	it("reads the type-argument form as well as the parameter form", () => {
		expect(extractConstraints('c.text<{ max: 10 }>("name")')).toEqual({ max: 10 })
		expect(extractConstraints('c.text("name", { max: 10 })')).toEqual({ max: 10 })
	})

	it("returns nothing when there is no constraint object", () => {
		expect(extractConstraints('c.text("name")')).toEqual({})
		expect(extractConstraints("not a column at all")).toEqual({})
	})

	it("parses booleans, integers and both quote styles", () => {
		expect(extractConstraints(`c.text("n", { trim: true, private: false, max: 42, a: "x", b: 'y' })`)).toEqual({
			a: "x",
			b: "y",
			max: 42,
			private: false,
			trim: true,
		})
	})

	it("keeps a regex literal intact despite its braces and commas", () => {
		const result = extractConstraints(String.raw`c.text("n", { pattern: /^\+[1-9]\d{7,14}$/, max: 16 })`)
		expect(result["max"]).toBe(16)
		expect(String(result["pattern"])).toContain("7,14")
	})

	it("un-escapes doubled backslashes in a quoted pattern", () => {
		const result = extractConstraints(String.raw`c.text("n", { pattern: "/^\\d+$/" })`)
		expect(result["pattern"]).toBe(String.raw`/^\d+$/`)
	})

	it("ignores a fragment with no colon", () => {
		expect(extractConstraints('c.text("n", { justAKey })')).toEqual({})
	})

	it("resolves a dotted identifier through the value map", () => {
		const values = new Map([["patterns.LOCALE", "/^[a-z]{2}$/"]])
		expect(extractConstraints('c.text("n", { pattern: patterns.LOCALE })', values)["pattern"]).toBe("/^[a-z]{2}$/")
		/* the values are the caller's, not the module's: another call does not see them */
		expect(extractConstraints('c.text("n", { pattern: patterns.LOCALE })')["pattern"]).toBe("patterns.LOCALE")
	})

	it("passes an unresolved identifier through verbatim", () => {
		expect(extractConstraints('c.text("n", { pattern: patterns.UNKNOWN })')["pattern"]).toBe("patterns.UNKNOWN")
	})

	it("returns nothing for an unbalanced constraint object", () => {
		expect(extractConstraints('c.text("n", { max: 10')).toEqual({})
	})
})

describe("constraint-text: the remaining forms", () => {
	it("reads the string constants a module the consumer can load exports", async () => {
		const fs = await import("node:fs")
		const os = await import("node:os")
		const path = await import("node:path")
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-values-"))
		try {
			fs.writeFileSync(
				path.join(dir, "patterns.cjs"),
				'module.exports = { patterns: { LOCALE: "^[a-z]{2}$", COUNT: 3 }, flag: true }',
			)
			const values = buildIdentifierValueMap(
				new Map([
					["patterns", "./patterns.cjs"],
					["flag", "./patterns.cjs"],
				]),
				dir,
			)
			expect([...values]).toEqual([["patterns.LOCALE", "^[a-z]{2}$"]])
		} finally {
			fs.rmSync(dir, { force: true, recursive: true })
		}
	})

	it("keeps nested braces inside a constraint object, and reads a length property", () => {
		expect(extractConstraints('c.text("n", { pattern: "^a{2}$", max: 5 })')).toEqual({ max: 5, pattern: "^a{2}$" })
		expect(extractConstraints('c.json("n", schema, { shape: { a: 1 }, maxBytes: 9 })')).toMatchObject({ maxBytes: 9 })
		expect(extractLength('c.text("n", { length: 50 })')).toBe(50)
	})
})

describe("constraint-text: slashes and separators", () => {
	it("tells a regex from a division, and skips empty pairs", () => {
		expect(extractConstraints('c.text("n", { pattern: /a\\/b,c/, min: 1, })')).toEqual({ min: 1, pattern: "/a\\/b,c/" })
		expect(extractConstraints('c.text("n", { max: 10/2 })')).toEqual({ max: "10/2" })
		expect(extractConstraints('c.text("n", {/x,y/})')).toEqual({})
		expect(extractConstraints('c.text("n", {})')).toEqual({})
		expect(extractConstraints('c.text("n", { min: 1,, max: 2 })')).toEqual({ max: 2, min: 1 })
	})
})
